import type { Auth } from "@opencode-ai/sdk";
import type { PluginInput } from "@opencode-ai/plugin";

import { refresh } from "./oauth";
import type { Store } from "./store";
import {
  CODEX_API_ENDPOINT,
  CODEX_USAGE_ENDPOINT,
  REFRESH_LEASE_MS,
  CONSERVATION_REF,
  CONSERVATION_HORIZON,
  CAPACITY_REF,
} from "./types";

type Client = PluginInput["client"];
type Row = NonNullable<ReturnType<Store["primary"]>>;
const QUOTA_CACHE_MS = 60_000;
const STALE_QUOTA_MS = 86_400_000;
const SWITCH_MARGIN = 0.2;
const AFFINITY_MS = 300_000;
const CONSERVATION_CAP = 1 + Math.log(CONSERVATION_HORIZON / CONSERVATION_REF);
const DORMANT_SLACK = 60;
const pending = new Map<string, Promise<number | null>>();

interface Affinity {
  id?: string;
  at: number;
  fast?: boolean;
}

interface AttemptResult {
  init: RequestInit | undefined;
  fast: boolean;
}

function active(affinity: Affinity) {
  return Boolean(affinity.id) && Date.now() - affinity.at < AFFINITY_MS;
}

type ScoreSource = "fresh" | "stale" | "missing";

interface ScoreView {
  id: string;
  name: string;
  plan: string;
  role: "core" | "pool";
  score?: number;
  source: ScoreSource;
}

interface RankResult {
  rows: Row[];
  scores: ScoreView[];
  reason?: string;
}

const decoder = new TextDecoder();
const FAST_WINDOW_BASE = 18_000;
const FAST_WINDOW_CEIL = 604_800;
const FAST_START_DROP = 0.2;
const FAST_END_SHORT = 0.7;
const FAST_END_LONG = 0.2;

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

interface ReadyWindow {
  used_percent: number;
  reset_after_seconds: number;
  limit_window_seconds: number;
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

interface UsageHit {
  at: number;
  body: Usage;
}

interface JsonBody {
  body: Record<string, unknown>;
  tier: boolean;
}

const FAST_DELTA = 0.1;
const usageCache = new Map<string, UsageHit>();
const loadingUsage = new Map<string, Promise<Usage | null>>();

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function weight(plan?: string) {
  const key = plan?.toLowerCase();
  if (key === "pro") return 6.7;
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

function name(row: Row) {
  return row.label || row.email || row.id.slice(0, 8);
}

function role(row: Row): "core" | "pool" {
  return row.primary === 1 ? "core" : "pool";
}

function plan(row: Row) {
  return row.plan_type ?? "unknown";
}

function quota(store: Store, row: Row, warm = false): ScoreView {
  const fresh = store.quota(row.id, QUOTA_CACHE_MS);
  if (fresh !== undefined) {
    return {
      id: row.id,
      name: name(row),
      plan: plan(row),
      role: role(row),
      score: fresh,
      source: "fresh",
    };
  }

  const stale = store.quota(row.id, STALE_QUOTA_MS);
  if (warm) void refreshQuota(store, row);
  if (stale !== undefined) {
    return {
      id: row.id,
      name: name(row),
      plan: plan(row),
      role: role(row),
      score: stale,
      source: "stale",
    };
  }

  return {
    id: row.id,
    name: name(row),
    plan: plan(row),
    role: role(row),
    source: "missing",
  };
}

function value(item: ScoreView) {
  if (item.source === "missing") return "n/a";

  const tags = [];
  if (item.score === 0) tags.push("blocked");
  if (item.source === "stale") tags.push("cached");
  const score = item.score?.toFixed(3) ?? "n/a";
  return tags.length > 0 ? `${score} ${tags.join(" ")}` : score;
}

function line(item: ScoreView, pick: string, nameWidth: number, planWidth: number) {
  const head = item.id === pick ? ">" : " ";
  const label = item.name.padEnd(nameWidth);
  const tier = `[${item.plan}]`.padEnd(planWidth + 2);
  return `${head} ${label} ${tier}: ${value(item)}`;
}

function describe(scores: ScoreView[], reason: string, pick: string) {
  const nameWidth = Math.max(...scores.map((item) => item.name.length));
  const planWidth = Math.max(...scores.map((item) => item.plan.length));
  const lines = [
    `Reason: ${reason}`,
    scores.length === 1 ? "Account:" : "Accounts:",
    ...scores.map((item) => line(item, pick, nameWidth, planWidth)),
  ];
  return lines.join("\n");
}

function fastLine(fast: boolean) {
  return `Fast-mode ${fast ? "enabled" : "disabled"}`;
}

function fastReason(fast: boolean) {
  return fast
    ? "usage is ahead of time"
    : "usage fell below threshold";
}

function selectionToast(
  client: Client,
  scores: ScoreView[],
  reason: string,
  pick: string,
  fast: boolean,
) {
  const detail = describe(scores, reason, pick);
  void client.tui.showToast({
    body: {
      title: "Codex Pool",
      message: `${fastLine(fast)}\n${detail}`,
      variant: "info",
      duration: 10_000,
    },
  });
}

function flipToast(client: Client, row: Row, fast: boolean) {
  void client.tui.showToast({
    body: {
      title: "Codex Pool",
      message:
        `${fastLine(fast)} - ${name(row)} (${role(row)})\n` +
        `Reason: ${fastReason(fast)}`,
      variant: "info",
      duration: 10_000,
    },
  });
}

function listed(scores: ScoreView[], item: ScoreView) {
  return scores.some((score) => score.id === item.id) ? scores : [...scores, item];
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

function conservation(secs: number) {
  return Math.max(
    1,
    Math.min(CONSERVATION_CAP, 1 + Math.log(secs / CONSERVATION_REF)),
  );
}

function dormant(win: Window, used: number) {
  if (used > 0) return false;

  const after = win.reset_after_seconds;
  if (typeof after !== "number" || !Number.isFinite(after) || after <= 0) return false;

  const span = win.limit_window_seconds;
  if (typeof span !== "number" || !Number.isFinite(span) || span <= 0) return false;

  return Math.abs(span - after) <= DORMANT_SLACK;
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
    const cap = Math.sqrt(span / CAPACITY_REF);
    if (dormant(win, used)) return plan * left * cap;

    const pace = Math.max(secs / span, 0.000001);
    const cons = conservation(secs);
    return (plan * left * cap) / (pace * cons);
  }

  return (plan * left) / secs;
}

function blocked(limit?: Limit) {
  if (!limit) return false;
  if (limit.allowed === false) return true;
  return limit.limit_reached === true;
}

function readyWindow(win?: Window): ReadyWindow | null | undefined {
  if (!win) return undefined;
  const used = win.used_percent;
  const after = win.reset_after_seconds;
  const span = win.limit_window_seconds;
  if (typeof used !== "number") return null;
  if (!Number.isFinite(used)) return null;
  if (typeof after !== "number") return null;
  if (!Number.isFinite(after) || after < 0) return null;
  if (typeof span !== "number") return null;
  if (!Number.isFinite(span) || span <= 0) return null;
  return {
    used_percent: used,
    reset_after_seconds: after,
    limit_window_seconds: span,
  };
}

function fastSpan(win: ReadyWindow) {
  const span = win.limit_window_seconds;
  if (span <= FAST_WINDOW_BASE) return 0;

  const base = Math.log(span / FAST_WINDOW_BASE);
  const ceil = Math.log(FAST_WINDOW_CEIL / FAST_WINDOW_BASE);
  return ceil > 0 ? clamp(base / ceil, 0, 1) : 0;
}

function fastNeed(win?: Window) {
  const item = readyWindow(win);
  if (item === undefined) return undefined;
  if (item === null) return null;

  const span = fastSpan(item);
  const time = clamp(
    item.reset_after_seconds / item.limit_window_seconds,
    0,
    1,
  );
  const start = FAST_DELTA * (1 - FAST_START_DROP * span);
  const end =
    FAST_DELTA * (FAST_END_SHORT - (FAST_END_SHORT - FAST_END_LONG) * span);
  return end + (start - end) * time;
}

function delta(win?: Window) {
  const item = readyWindow(win);
  if (item === undefined) return undefined;
  if (item === null) return null;
  const left = 1 - clamp(item.used_percent, 0, 100) / 100;
  const time = clamp(
    item.reset_after_seconds / item.limit_window_seconds,
    0,
    1,
  );
  const need = fastNeed(item);
  if (typeof need !== "number") return null;
  return left - time - need;
}

function limitDelta(limit?: Limit) {
  if (!limit) return undefined;
  if (blocked(limit)) return null;

  const list = [delta(limit.primary_window), delta(limit.secondary_window)];
  if (list.includes(null)) return null;
  const values = list.filter((item): item is number => item !== undefined);
  if (values.length === 0) return null;
  return Math.min(...values);
}

function fast(usage: Usage) {
  const list = [limitDelta(usage.rate_limit)];
  for (const item of usage.additional_rate_limits ?? []) {
    list.push(limitDelta(item.rate_limit));
  }
  if (list.includes(null)) return false;
  const values = list.filter((item): item is number => item !== undefined);
  if (values.length === 0) return false;
  return Math.min(...values) >= 0;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseBody(body: ArrayBuffer | null) {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(decoder.decode(body));
    if (!object(parsed)) return undefined;
    return {
      body: parsed,
      tier: "service_tier" in parsed || "serviceTier" in parsed,
    } satisfies JsonBody;
  } catch {
    return undefined;
  }
}

function withPriority(parsed: JsonBody | undefined) {
  if (!parsed || parsed.tier) return undefined;
  return {
    ...parsed.body,
    service_tier: "priority",
  } satisfies Record<string, unknown>;
}

async function snapshot(input: RequestInfo | URL, init?: RequestInit) {
  const src =
    init?.body ?? (input instanceof Request ? input.clone().body ?? undefined : undefined);
  if (!src) return null;
  if (src instanceof ArrayBuffer) return src.slice(0);
  if (ArrayBuffer.isView(src)) {
    return src.buffer.slice(
      src.byteOffset,
      src.byteOffset + src.byteLength,
    ) as ArrayBuffer;
  }
  return await new Response(src).arrayBuffer();
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
  if (!row.chatgpt_account_id) return null;

  const hit = store.quota(row.id, QUOTA_CACHE_MS);
  if (hit !== undefined) return hit;

  const held = pending.get(row.id);
  if (held) return held;

  const load = (async () => {
    try {
      const usage = await loadUsage(store, row);
      const value = usage ? score(usage) : null;
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

type UsageSource = "fresh" | "stale" | "missing";

function cachedUsage(row: Row) {
  return usageCache.get(row.id)?.body ?? null;
}

function usageSource(row: Row): UsageSource {
  const cached = usageCache.get(row.id);
  if (!cached) return "missing";
  return Date.now() - cached.at < QUOTA_CACHE_MS ? "fresh" : "stale";
}

async function loadUsage(store: Store, row: Row) {
  const account = row.chatgpt_account_id;
  if (!account) return null;

  const cached = usageCache.get(row.id);
  if (cached && Date.now() - cached.at < QUOTA_CACHE_MS) return cached.body;

  const held = loadingUsage.get(row.id);
  if (held) return held;

  const load = (async () => {
    try {
      const headers = new Headers();
      headers.set("authorization", `Bearer ${row.access_token}`);
      headers.set("accept", "application/json");
      headers.set("ChatGPT-Account-Id", account);

      const res = await fetch(CODEX_USAGE_ENDPOINT, { headers });
      if (!res.ok) return null;
      const usage = ((await res.json()) as Usage) ?? {};
      const value = score(usage);
      if (value !== null) store.cacheQuota(row.id, value);
      if (usage.plan_type) store.updatePlanType(row.id, usage.plan_type);
      usageCache.set(row.id, { at: Date.now(), body: usage });
      return usage;
    } catch {
      return null;
    } finally {
      loadingUsage.delete(row.id);
    }
  })();

  loadingUsage.set(row.id, load);
  return load;
}

function attempt(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  parsed: JsonBody | undefined,
  usage: Usage | null,
) : AttemptResult {
  const url = rewrite(input).toString();
  if (url !== CODEX_API_ENDPOINT) return { init, fast: false };
  const body = withPriority(parsed);
  if (!body) return { init, fast: false };
  if (!usage || !fast(usage)) return { init, fast: false };
  return {
    init: {
      ...init,
      body: new TextEncoder().encode(JSON.stringify(body)).buffer,
    } satisfies RequestInit,
    fast: true,
  };
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

function rank(store: Store, rows: Row[], affinity: Affinity): RankResult {
  const core = rows.find((item) => item.primary === 1);
  const pool = rows.find((item) => item.primary !== 1);
  if (!core || !pool) {
    return {
      rows,
      scores: rows.map((row) => quota(store, row)),
      reason: rows.length === 1 ? "only available account" : undefined,
    };
  }

  const aScore = quota(store, core, true);
  const bScore = quota(store, pool, true);
  const list = [aScore, bScore];
  const a = aScore.score;
  const b = bScore.score;
  if (a === undefined || b === undefined) {
    return {
      rows,
      scores: list,
      reason: "quota cache warming",
    };
  }

  const rest = rows.filter((item) => item.id !== core.id);

  if (affinity.id && Date.now() - affinity.at < AFFINITY_MS) {
    const hi = Math.max(a, b, 0.001);
    const margin = SWITCH_MARGIN * (0.5 + 0.5 * Math.min(a, b) / hi);
    if (affinity.id === core.id && a > 0) {
      return b > a * (1 + margin)
        ? {
            rows: [...rest, core],
            scores: list,
            reason: "higher score beat sticky core",
          }
        : {
            rows: [core, ...rest],
            scores: list,
            reason: "sticky session kept core",
          };
    }
    if (affinity.id === pool.id && b > 0) {
      return a > b * (1 + margin)
        ? {
            rows: [core, ...rest],
            scores: list,
            reason: "higher score beat sticky pool",
          }
        : {
            rows: [...rest, core],
            scores: list,
            reason: "sticky session kept pool",
          };
    }
  }

  if (a >= b) {
    return {
      rows: [core, ...rest],
      scores: list,
      reason: a === b ? "tied score kept core priority" : "higher score",
    };
  }

  return {
    rows: [...rest, core],
    scores: list,
    reason: "higher score",
  };
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
    usageCache.delete(row.id);
    loadingUsage.delete(row.id);
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

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const auth = await getAuth();
    if (auth.type !== "oauth") return fetch(input, init);

    let body: ArrayBuffer | null = null;
    body = await snapshot(input, init);
    const snap = body ? { ...init, body } : init;
    const parsed = parseBody(body);
    const candidate = withPriority(parsed);

    const session = cacheKey(body);
    let affinity: Affinity = { at: 0 };
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
    const ranked = rank(store, rows, affinity);
    const ordered = ranked.rows;
    const list =
      ordered.length > 0
        ? ordered
        : [pick(store)].filter((row) => row !== undefined);

    if (candidate && list.length === 1) {
      const state = usageSource(list[0]);
      if (state === "missing") {
        await loadUsage(store, list[0]);
      }
      if (state === "stale") {
        void loadUsage(store, list[0]);
      }
    }

    let last: Response | Error | undefined;
    let note: string | undefined;

    for (const item of list) {
      let row = item;

      try {
        if (row.expires_at <= Date.now()) {
          row = await renew(store, row, client);
        }

        const state = usageSource(row);
        if (state === "stale") void loadUsage(store, row);
        let used = attempt(input, snap, parsed, cachedUsage(row));
        const sticky = active(affinity);
        if (!sticky || affinity.id !== row.id) {
          const scores = listed(
            ranked.scores.length > 0 ? ranked.scores : [quota(store, row)],
            quota(store, row),
          );
          selectionToast(
            client,
            scores,
            note ?? ranked.reason ?? "selected account",
            row.id,
            used.fast,
          );
        } else if (affinity.fast !== undefined && affinity.fast !== used.fast) {
          flipToast(client, row, used.fast);
        }
        let res = await send(input, used.init, row);

        if (res.status === 401) {
          row = await renew(store, row, client);
          used = attempt(input, snap, parsed, cachedUsage(row));
          res = await send(input, used.init, row);
        }

        if (res.status === 429) {
          const ms = wait(res);
          note = `${name(row)} hit 429 cooldown`;
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
          note = `${name(row)} stayed unauthorized`;
          store.disable(row.id, res.statusText || "unauthorized");
          last = res;
          continue;
        }

        if (res.ok) {
          store.enable(row.id);
          store.clearCooldown(row.id);
          if (session) {
            affinity.id = row.id;
            affinity.at = Date.now();
            affinity.fast = used.fast;
          }
        }

        return res;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        note = `${name(row)} errored`;
        store.disable(row.id, msg);
        last = err instanceof Error ? err : new Error(msg);
      }
    }

    if (last instanceof Response) return last;
    if (last) throw last;
    return fetch(input, init);
  };
}
