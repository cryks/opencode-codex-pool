import type { Auth } from "@opencode-ai/sdk";
import type { PluginInput } from "@opencode-ai/plugin";

import { refresh } from "./oauth";
import type { Store } from "./store";
import { CODEX_API_ENDPOINT, REFRESH_LEASE_MS } from "./types";

type Client = PluginInput["client"];

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

function pick(store: Store) {
  store.clearExpired();
  return store.available()[0] ?? store.primary() ?? store.list()[0];
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

    const rows = store.available();
    const list =
      rows.length > 0 ? rows : [pick(store)].filter((row) => row !== undefined);
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
