import type { Auth } from "@opencode-ai/sdk";
import type { PluginInput } from "@opencode-ai/plugin";

import { refresh } from "./oauth";
import type { Store } from "./store";
import {
  CODEX_API_ENDPOINT,
  CODEX_USAGE_ENDPOINT,
  REFRESH_LEASE_MS,
} from "./types";

type Client = PluginInput["client"];
type Row = NonNullable<ReturnType<Store["primary"]>>;
const QUOTA_CACHE_MS = 60_000;
const STALE_QUOTA_MS = 86_400_000;
const SWITCH_MARGIN = 0.2;
const AFFINITY_MS = 300_000;
const pending = new Map<string, Promise<number | null>>();

interface Affinity {
  id?: string;
  at: number;
}

const decoder = new TextDecoder();

function cacheKey(body: ArrayBuffer | null): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(decoder.decode(body));
    const key = parsed.prompt_cache_key;
    return typeof key === "string" ? key : undefined;
  } catch {
    return undefined;
  }
}

interface Window {
  used_percent?: number;
  reset_after_seconds?: number;
  limit_window_seconds?: number;
}

interface Limit {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: Window;
  secondary_window?: Window;
}

interface Usage {
  plan_type?: string;
  rate_limit?: Limit;
  additional_rate_limits?: Array<{
    rate_limit?: Limit;
  }>;
}

function weight(plan?: string) {
  const key = plan?.toLowerCase();
  if (key === "pro") return 10;
  if (key === "plus") return 1;
  if (key === "team") return 1;
  return 1;
}

function mirror(
  client: Client,
  row: {
    id: string;
    access_token: string;
    refresh_token: string;
    expires_at: number;
  },
) {
  return client.auth.set({
    path: { id: "openai" },
    body: {
      type: "oauth",
      refresh: row.refresh_token,
      access: row.access_token,
      expires: row.expires_at,
    } satisfies Auth,
  });
}

function copy(input: RequestInfo | URL, init?: HeadersInit) {
  const headers = new Headers(
    input instanceof Request ? input.headers : undefined,
  );
  const next = new Headers(init);

  next.forEach((value, key) => {
    headers.set(key, value);
  });

  headers.delete("authorization");
  headers.delete("Authorization");
  return headers;
}

function rewrite(input: RequestInfo | URL) {
  const src =
    input instanceof URL
      ? input.href
      : input instanceof Request
        ? input.url
        : input;
  const url = new URL(src);

  if (
    url.pathname.includes("/v1/responses") ||
    url.pathname.includes("/chat/completions")
  ) {
    return new URL(CODEX_API_ENDPOINT);
  }

  return url;
}

function wait(res: Response) {
  const raw = res.headers.get("retry-after");
  if (!raw) return 60_000;

  const secs = Number(raw);
  if (Number.isFinite(secs) && secs > 0) return secs * 1000;

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return 60_000;
  return Math.max(at - Date.now(), 1000);
}

function reset(win: Window) {
  const after = win.reset_after_seconds;
  if (typeof after === "number" && Number.isFinite(after) && after > 0) return after;

  const span = win.limit_window_seconds;
  if (typeof span === "number" && Number.isFinite(span) && span > 0) return span;
  return null;
}

function windowScore(win: Window | undefined, plan: number) {
  if (!win) return null;
  if (typeof win.used_percent !== "number") return null;
  if (!Number.isFinite(win.used_percent)) return null;

  const used = Math.min(Math.max(win.used_percent, 0), 100);
  const left = 1 - used / 100;
  const secs = reset(win);
  if (secs === null) return null;

  const span = win.limit_window_seconds;
  if (typeof span === "number" && Number.isFinite(span) && span > 0) {
    const pace = Math.max(secs / span, 0.000001);
    return (plan * left) / pace;
  }

  return (plan * left) / secs;
}

function blocked(limit?: Limit) {
  if (!limit) return false;
  if (limit.allowed === false) return true;
  return limit.limit_reached === true;
}

function limitScore(limit: Limit | undefined, plan: number) {
  if (!limit) return null;
  if (blocked(limit)) return 0;

  const list = [
    windowScore(limit.primary_window, plan),
    windowScore(limit.secondary_window, plan),
  ].filter((item): item is number => item !== null);

  if (list.length === 0) return null;
  return Math.min(...list);
}

function score(body: Usage) {
  const plan = weight(body.plan_type);
  const list = [limitScore(body.rate_limit, plan)];

  for (const item of body.additional_rate_limits ?? []) {
    list.push(limitScore(item.rate_limit, plan));
  }

  if (list.includes(0)) return 0;

  const values = list.filter(
    (item): item is number => item !== null,
  );

  if (values.length === 0) return null;
  return Math.min(...values);
}

function refreshQuota(store: Store, row: Row) {
  const account = row.chatgpt_account_id;
  if (!account) return null;

  const hit = store.quota(row.id, QUOTA_CACHE_MS);
  if (hit !== undefined) return hit;

  const held = pending.get(row.id);
  if (held) return held;

  const load = (async () => {
    try {
      const headers = new Headers();
      headers.set("authorization", `Bearer ${row.access_token}`);
      headers.set("accept", "application/json");
      headers.set("ChatGPT-Account-Id", account);

      const res = await fetch(CODEX_USAGE_ENDPOINT, { headers });
      const usage = res.ok ? (((await res.json()) as Usage) ?? {}) : null;
      const value = usage ? score(usage) : null;
      if (value !== null) store.cacheQuota(row.id, value);
      if (usage?.plan_type) store.updatePlanType(row.id, usage.plan_type);
      return value;
    } catch {
      return null;
    } finally {
      pending.delete(row.id);
    }
  })();

  pending.set(row.id, load);
  return load;
}

function pick(store: Store) {
  store.clearExpired();
  return store.available()[0] ?? store.primary() ?? store.list()[0];
}

async function ready(store: Store, row: Row, client: Client) {
  if (row.expires_at > Date.now()) return row;

  try {
    return await renew(store, row, client);
  } catch {
    return row;
  }
}

function rank(store: Store, rows: Row[], affinity: Affinity) {
  const core = rows.find((item) => item.primary === 1);
  const pool = rows.find((item) => item.primary !== 1);
  if (!core || !pool) return rows;

  let a = store.quota(core.id, QUOTA_CACHE_MS);
  let b = store.quota(pool.id, QUOTA_CACHE_MS);

  if (a === undefined || b === undefined) {
    if (a === undefined) {
      a = store.quota(core.id, STALE_QUOTA_MS);
      void refreshQuota(store, core);
    }
    if (b === undefined) {
      b = store.quota(pool.id, STALE_QUOTA_MS);
      void refreshQuota(store, pool);
    }
    if (a === undefined || b === undefined) return rows;
  }

  const rest = rows.filter((item) => item.id !== core.id);

  if (affinity.id && Date.now() - affinity.at < AFFINITY_MS) {
    if (affinity.id === core.id && a > 0) {
      return b > a * (1 + SWITCH_MARGIN) ? [...rest, core] : [core, ...rest];
    }
    if (affinity.id === pool.id && b > 0) {
      return a > b * (1 + SWITCH_MARGIN) ? [core, ...rest] : [...rest, core];
    }
  }

  if (a >= b) return [core, ...rest];
  return [...rest, core];
}

async function renew(
  store: Store,
  row: NonNullable<ReturnType<Store["primary"]>>,
  client: Client,
) {
  const key = `refresh:${row.id}`;
  const owner = crypto.randomUUID();

  if (!store.acquireLock(key, owner, REFRESH_LEASE_MS)) {
    // Another instance is refreshing — wait briefly, then re-read from store
    await new Promise((r) => setTimeout(r, 2000));
    const fresh = store.get(row.id);
    if (fresh && fresh.expires_at > Date.now()) return fresh;
    // Lock expired or tokens still stale — proceed with refresh anyway
  }

  try {
    const tokens = await refresh(row.refresh_token);
    const expires = Date.now() + (tokens.expires_in ?? 3600) * 1000;

    store.updateTokens(
      row.id,
      tokens.access_token,
      tokens.refresh_token,
      expires,
    );
    store.clearQuota(row.id);
    pending.delete(row.id);
    store.enable(row.id);
    store.clearCooldown(row.id);

    if (store.primary()?.id === row.id) {
      await mirror(client, {
        id: row.id,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expires,
      });
    }

    return (
      store.get(row.id) ?? {
        ...row,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expires,
      }
    );
  } finally {
    store.releaseLock(key, owner);
  }
}

async function send(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  row: NonNullable<ReturnType<Store["primary"]>>,
) {
  const headers = copy(input, init?.headers);
  headers.set("authorization", `Bearer ${row.access_token}`);

  if (row.chatgpt_account_id) {
    headers.set("ChatGPT-Account-Id", row.chatgpt_account_id);
  }

  const req =
    input instanceof Request
      ? new Request(rewrite(input), input)
      : rewrite(input);

  return fetch(req, {
    ...init,
    headers,
  });
}

export function createFetch(
  store: Store,
  getAuth: () => Promise<Auth>,
  client: Client,
) {
  const sessions = new Map<string, Affinity>();
  const noAffinity: Affinity = { at: 0 };

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const auth = await getAuth();
    if (auth.type !== "oauth") return fetch(input, init);

    let body: ArrayBuffer | null = null;
    if (init?.body) {
      if (init.body instanceof ReadableStream) {
        body = await new Response(init.body).arrayBuffer();
      } else if (init.body instanceof ArrayBuffer) {
        body = init.body;
      } else if (ArrayBuffer.isView(init.body)) {
        body = init.body.buffer.slice(
          init.body.byteOffset,
          init.body.byteOffset + init.body.byteLength,
        ) as ArrayBuffer;
      } else if (typeof init.body === "string") {
        body = new TextEncoder().encode(init.body).buffer as ArrayBuffer;
      }
    }
    const snap = body ? { ...init, body } : init;

    const session = cacheKey(body);
    let affinity = noAffinity;
    if (session) {
      const entry = sessions.get(session);
      if (entry) {
        affinity = entry;
      } else {
        affinity = { at: 0 };
        sessions.set(session, affinity);
      }
      if (sessions.size > 50) {
        const now = Date.now();
        for (const [k, v] of sessions) {
          if (now - v.at >= AFFINITY_MS) sessions.delete(k);
        }
      }
    }

    const rows = await Promise.all(
      store.available().map((item) => ready(store, item, client)),
    );
    const ordered = rank(store, rows, affinity);
    const list =
      ordered.length > 0
        ? ordered
        : [pick(store)].filter((row) => row !== undefined);
    let last: Response | Error | undefined;

    for (const item of list) {
      let row = item;

      try {
        if (row.expires_at <= Date.now()) {
          row = await renew(store, row, client);
        }

        let res = await send(input, snap, row);

        if (res.status === 401) {
          row = await renew(store, row, client);
          res = await send(input, snap, row);
        }

        if (res.status === 429) {
          const ms = wait(res);
          store.setCooldown(
            row.id,
            Date.now() + ms,
            res.status,
            res.statusText || "rate_limited",
            ms,
          );
          last = res;
          continue;
        }

        if (res.status === 401) {
          store.disable(row.id, res.statusText || "unauthorized");
          last = res;
          continue;
        }

        if (res.ok) {
          store.enable(row.id);
          store.clearCooldown(row.id);
          if (affinity.id !== row.id) {
            const name = row.label || row.email || row.id.slice(0, 8);
            const plan = row.plan_type ?? "unknown";
            const role = row.primary === 1 ? "core" : "pool";
            void client.tui.showToast({
              body: {
                title: "Codex Pool",
                message: `Using ${name} — ${plan} (${role})`,
                variant: "info",
                duration: 3000,
              },
            });
          }
          affinity.id = row.id;
          affinity.at = Date.now();
        }

        return res;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        store.disable(row.id, msg);
        last = err instanceof Error ? err : new Error(msg);
      }
    }

    if (last instanceof Response) return last;
    if (last) throw last;
    return fetch(input, init);
  };
}
