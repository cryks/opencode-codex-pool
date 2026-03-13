import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PluginInput } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk";

import { createFetch } from "../src/fetch";
import { open } from "../src/store";
import type { Store } from "../src/store";
import { CODEX_API_ENDPOINT, REFRESH_LEASE_MS } from "../src/types";
import type { Account } from "../src/types";

interface Hit {
  url: string;
  auth: string | null;
  body: string;
}

function row(
  id: string,
  priority: number,
  over: Partial<Account> = {},
): Account {
  const now = Date.now();
  return {
    id,
    subject: `${id}-subject`,
    email: `${id}@example.com`,
    chatgpt_account_id: `${id}-chat`,
    label: id,
    priority,
    primary: 0,
    access_token: `${id}-access`,
    refresh_token: `${id}-refresh`,
    expires_at: now + 3_600_000,
    disabled_at: null,
    last_error: null,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

function auth(): Auth {
  return {
    type: "oauth",
    access: "a",
    refresh: "r",
    expires: Date.now() + 3_600_000,
  };
}

function stub() {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      auth: {
        set: async (input: unknown) => {
          calls.push(input);
          return {};
        },
      },
    } as unknown as PluginInput["client"],
  };
}

function url(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : input.toString();
}

async function snap(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Hit> {
  return {
    url: url(input),
    auth: new Headers(init?.headers).get("authorization"),
    body: init?.body ? await new Response(init.body).text() : "",
  };
}

describe("createFetch", () => {
  let store: Store;
  let old: typeof fetch;
  let wait: typeof setTimeout;

  beforeEach(() => {
    store = open(":memory:");
    old = globalThis.fetch;
    wait = globalThis.setTimeout;
  });

  afterEach(() => {
    globalThis.fetch = old;
    globalThis.setTimeout = wait;
    store.close();
  });

  test("returns a normal response with one account", async () => {
    store.upsert(row("a", 0));

    const hits: Hit[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      hits.push(await snap(input, init));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(hits).toEqual([
      { url: CODEX_API_ENDPOINT, auth: "Bearer a-access", body: "" },
    ]);
  });

  test("fails over on 429 and cools down the first account", async () => {
    store.upsert(row("a", 0));
    store.upsert(row("b", 1));

    const hits: Hit[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      hits.push(await snap(input, init));

      if (hits.length === 1) {
        return new Response("slow", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "1" },
        });
      }

      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(hits.map((item) => item.auth)).toEqual([
      "Bearer a-access",
      "Bearer b-access",
    ]);
    expect(store.available().map((item) => item.id)).toEqual(["b"]);
  });

  test("reuses a snapshotted request body after failover", async () => {
    store.upsert(row("a", 0));
    store.upsert(row("b", 1));

    const hits: Hit[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      hits.push(await snap(input, init));

      if (hits.length === 1) {
        return new Response("slow", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "1" },
        });
      }

      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: "payload",
      headers: { "content-type": "text/plain" },
    });

    expect(res.status).toBe(200);
    expect(hits.map((item) => item.body)).toEqual(["payload", "payload"]);
    expect(hits.map((item) => item.auth)).toEqual([
      "Bearer a-access",
      "Bearer b-access",
    ]);
  });

  test("refreshes tokens after a 401 and updates the store", async () => {
    store.upsert(row("a", 0));
    store.setPrimary("a");

    const hits: Hit[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const hit = await snap(input, init);
      hits.push(hit);

      if (hit.url === "https://auth.openai.com/oauth/token") {
        return new Response(
          JSON.stringify({
            access_token: "next-access",
            refresh_token: "next-refresh",
            expires_in: 60,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (hits.filter((item) => item.url === CODEX_API_ENDPOINT).length === 1) {
        return new Response("unauthorized", {
          status: 401,
          statusText: "Unauthorized",
        });
      }

      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { calls, client } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses");
    const item = store.get("a");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(item).toMatchObject({
      access_token: "next-access",
      refresh_token: "next-refresh",
    });
    expect(item && item.expires_at > Date.now()).toBe(true);
    expect(hits.map((item) => item.url)).toEqual([
      CODEX_API_ENDPOINT,
      "https://auth.openai.com/oauth/token",
      CODEX_API_ENDPOINT,
    ]);
    expect(hits.map((item) => item.auth)).toEqual([
      "Bearer a-access",
      null,
      "Bearer next-access",
    ]);
    expect(calls).toEqual([
      {
        path: { id: "openai" },
        body: {
          type: "oauth",
          refresh: "next-refresh",
          access: "next-access",
          expires: item?.expires_at,
        },
      },
    ]);
  });

  test("uses fresh store tokens when another owner holds the refresh lock", async () => {
    store.upsert(
      row("a", 0, {
        access_token: "stale-access",
        refresh_token: "stale-refresh",
        expires_at: Date.now() - 1_000,
      }),
    );
    store.acquireLock("refresh:a", "other", REFRESH_LEASE_MS);

    globalThis.setTimeout = ((
      fn: ((...args: unknown[]) => void) | string,
      _ms?: number,
      ...args: unknown[]
    ) => {
      store.updateTokens(
        "a",
        "fresh-access",
        "fresh-refresh",
        Date.now() + 3_600_000,
      );

      if (typeof fn === "function") fn(...args);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    const hits: Hit[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      hits.push(await snap(input, init));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { calls, client } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: "x",
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(hits).toEqual([
      { url: CODEX_API_ENDPOINT, auth: "Bearer fresh-access", body: "x" },
    ]);
    expect(calls).toEqual([]);
  });

  test("returns the last 429 when every account is rate limited", async () => {
    store.upsert(row("a", 0));
    store.upsert(row("b", 1));

    const hits: Hit[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      hits.push(await snap(input, init));
      return new Response(`slow-${hits.length}`, {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "retry-after": "1" },
      });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses");

    expect(res.status).toBe(429);
    expect(await res.text()).toBe("slow-2");
    expect(hits.map((item) => item.auth)).toEqual([
      "Bearer a-access",
      "Bearer b-access",
    ]);
  });

  test("falls back to native fetch when the store is empty", async () => {
    const hits: Hit[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      hits.push(await snap(input, init));
      return new Response("native", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://example.com/plain", {
      method: "POST",
      body: "native-body",
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("native");
    expect(hits).toEqual([
      { url: "https://example.com/plain", auth: null, body: "native-body" },
    ]);
  });
});
