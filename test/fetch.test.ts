import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PluginInput } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk";

import { createFetch } from "../src/fetch";
import { open } from "../src/store";
import type { Store } from "../src/store";
import {
  CODEX_API_ENDPOINT,
  CODEX_USAGE_ENDPOINT,
  REFRESH_LEASE_MS,
} from "../src/types";
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

function usage(body: Record<string, unknown>): Response;
function usage(used: number, reset: number): Response;
function usage(input: number | Record<string, unknown>, reset?: number) {
  const body =
    typeof input === "number"
      ? {
          rate_limit: {
            primary_window: {
              used_percent: input,
              reset_after_seconds: reset,
            },
          },
        }
      : input;

  return new Response(
    JSON.stringify(body),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
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

  test("prefers pool before core when pool has more quota to burn before reset", async () => {
    store.upsert(row("core-fast", 0, { primary: 1 }));
    store.setPrimary("core-fast");
    store.upsert(row("pool-fast", 1));
    store.cacheQuota("core-fast", (100 - 80) / 7_200);
    store.cacheQuota("pool-fast", (100 - 20) / 600);

    const hits: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const auth = new Headers(init?.headers).get("authorization");

      hits.push(auth ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(hits).toEqual(["Bearer pool-fast-access"]);
  });

  test("keeps core before pool when core is more urgent to spend", async () => {
    store.upsert(row("core-soon", 0, { primary: 1 }));
    store.setPrimary("core-soon");
    store.upsert(row("pool-later", 1));
    store.cacheQuota("core-soon", (100 - 20) / 600);
    store.cacheQuota("pool-later", (100 - 80) / 7_200);

    const hits: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const auth = new Headers(init?.headers).get("authorization");

      hits.push(auth ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(hits).toEqual(["Bearer core-soon-access"]);
  });

  test("prefers pro pool over plus core when relative usage is equal", async () => {
    store.upsert(row("core-plus", 0, { primary: 1 }));
    store.setPrimary("core-plus");
    store.upsert(row("pool-pro", 1));

    let scans = 0;
    const hits: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = url(input);
      const auth = new Headers(init?.headers).get("authorization");

      if (target === CODEX_USAGE_ENDPOINT) {
        scans += 1;
        if (auth === "Bearer core-plus-access") {
          return usage({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 50,
                reset_after_seconds: 600,
                limit_window_seconds: 18_000,
              },
            },
          });
        }

        return usage({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 50,
              reset_after_seconds: 600,
              limit_window_seconds: 18_000,
            },
          },
        });
      }

      hits.push(auth ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);

    await run("https://api.openai.com/v1/responses");
    await Bun.sleep(0);
    const second = await run("https://api.openai.com/v1/responses");

    expect(second.status).toBe(200);
    expect(scans).toBe(2);
    expect(hits).toEqual([
      "Bearer core-plus-access",
      "Bearer pool-pro-access",
    ]);
  });

  test("defaults unknown plan_type to weight 1", async () => {
    store.upsert(row("core-unknown", 0, { primary: 1 }));
    store.setPrimary("core-unknown");
    store.upsert(row("pool-plus", 1));

    const hits: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = url(input);
      const auth = new Headers(init?.headers).get("authorization");

      if (target === CODEX_USAGE_ENDPOINT) {
        if (auth === "Bearer core-unknown-access") {
          return usage({
            plan_type: "enterprise",
            rate_limit: {
              primary_window: {
                used_percent: 50,
                reset_after_seconds: 600,
                limit_window_seconds: 18_000,
              },
            },
          });
        }

        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 50,
              reset_after_seconds: 600,
              limit_window_seconds: 18_000,
            },
          },
        });
      }

      hits.push(auth ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);

    await run("https://api.openai.com/v1/responses");
    await Bun.sleep(0);
    const second = await run("https://api.openai.com/v1/responses");

    expect(second.status).toBe(200);
    expect(hits).toEqual([
      "Bearer core-unknown-access",
      "Bearer core-unknown-access",
    ]);
  });

  test("treats allowed false as unavailable", async () => {
    store.upsert(row("core-blocked", 0, { primary: 1 }));
    store.setPrimary("core-blocked");
    store.upsert(row("pool-open", 1));

    const hits: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = url(input);
      const auth = new Headers(init?.headers).get("authorization");

      if (target === CODEX_USAGE_ENDPOINT) {
        if (auth === "Bearer core-blocked-access") {
          return usage({
            plan_type: "plus",
            rate_limit: {
              allowed: false,
              primary_window: {
                used_percent: 1,
                reset_after_seconds: 60,
                limit_window_seconds: 18_000,
              },
            },
          });
        }

        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 90,
              reset_after_seconds: 600,
              limit_window_seconds: 18_000,
            },
          },
        });
      }

      hits.push(auth ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);

    await run("https://api.openai.com/v1/responses");
    await Bun.sleep(0);
    const second = await run("https://api.openai.com/v1/responses");

    expect(second.status).toBe(200);
    expect(hits).toEqual([
      "Bearer core-blocked-access",
      "Bearer pool-open-access",
    ]);
  });

  test("treats limit_reached true as unavailable", async () => {
    store.upsert(row("core-limit", 0, { primary: 1 }));
    store.setPrimary("core-limit");
    store.upsert(row("pool-ready", 1));

    const hits: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = url(input);
      const auth = new Headers(init?.headers).get("authorization");

      if (target === CODEX_USAGE_ENDPOINT) {
        if (auth === "Bearer core-limit-access") {
          return usage({
            plan_type: "plus",
            rate_limit: {
              limit_reached: true,
              primary_window: {
                used_percent: 10,
                reset_after_seconds: 60,
                limit_window_seconds: 18_000,
              },
            },
          });
        }

        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 90,
              reset_after_seconds: 600,
              limit_window_seconds: 18_000,
            },
          },
        });
      }

      hits.push(auth ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);

    await run("https://api.openai.com/v1/responses");
    await Bun.sleep(0);
    const second = await run("https://api.openai.com/v1/responses");

    expect(second.status).toBe(200);
    expect(hits).toEqual([
      "Bearer core-limit-access",
      "Bearer pool-ready-access",
    ]);
  });

  test("uses limit_window_seconds when reset_after_seconds is missing", async () => {
    store.upsert(row("core-missing-reset", 0, { primary: 1 }));
    store.setPrimary("core-missing-reset");
    store.upsert(row("pool-missing-reset", 1));

    const hits: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = url(input);
      const auth = new Headers(init?.headers).get("authorization");

      if (target === CODEX_USAGE_ENDPOINT) {
        if (auth === "Bearer core-missing-reset-access") {
          return usage({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 80,
                limit_window_seconds: 18_000,
              },
            },
          });
        }

        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 20,
              limit_window_seconds: 18_000,
            },
          },
        });
      }

      hits.push(auth ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);

    await run("https://api.openai.com/v1/responses");
    await Bun.sleep(0);
    const second = await run("https://api.openai.com/v1/responses");

    expect(second.status).toBe(200);
    expect(hits).toEqual([
      "Bearer core-missing-reset-access",
      "Bearer pool-missing-reset-access",
    ]);
  });

  test("uses the minimum score across primary and secondary windows", async () => {
    store.upsert(row("core-two-window", 0, { primary: 1 }));
    store.setPrimary("core-two-window");
    store.upsert(row("pool-mid", 1));

    const hits: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = url(input);
      const auth = new Headers(init?.headers).get("authorization");

      if (target === CODEX_USAGE_ENDPOINT) {
        if (auth === "Bearer core-two-window-access") {
          return usage({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 5,
                reset_after_seconds: 60,
                limit_window_seconds: 18_000,
              },
              secondary_window: {
                used_percent: 99,
                reset_after_seconds: 600,
                limit_window_seconds: 604_800,
              },
            },
          });
        }

        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 50,
              reset_after_seconds: 600,
              limit_window_seconds: 18_000,
            },
          },
        });
      }

      hits.push(auth ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);

    await run("https://api.openai.com/v1/responses");
    await Bun.sleep(0);
    const second = await run("https://api.openai.com/v1/responses");

    expect(second.status).toBe(200);
    expect(hits).toEqual([
      "Bearer core-two-window-access",
      "Bearer pool-mid-access",
    ]);
  });

  test("uses the minimum score across additional rate limits", async () => {
    store.upsert(row("core-additional", 0, { primary: 1 }));
    store.setPrimary("core-additional");
    store.upsert(row("pool-plain", 1));

    const hits: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = url(input);
      const auth = new Headers(init?.headers).get("authorization");

      if (target === CODEX_USAGE_ENDPOINT) {
        if (auth === "Bearer core-additional-access") {
          return usage({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 5,
                reset_after_seconds: 60,
                limit_window_seconds: 18_000,
              },
            },
            additional_rate_limits: [
              {
                rate_limit: {
                  primary_window: {
                    used_percent: 99,
                    reset_after_seconds: 600,
                    limit_window_seconds: 18_000,
                  },
                },
              },
            ],
          });
        }

        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 50,
              reset_after_seconds: 600,
              limit_window_seconds: 18_000,
            },
          },
        });
      }

      hits.push(auth ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);

    await run("https://api.openai.com/v1/responses");
    await Bun.sleep(0);
    const second = await run("https://api.openai.com/v1/responses");

    expect(second.status).toBe(200);
    expect(hits).toEqual([
      "Bearer core-additional-access",
      "Bearer pool-plain-access",
    ]);
  });

  test("cold quota cache keeps the current request on core and warms future ranking in the background", async () => {
    store.upsert(row("core-cache", 0, { primary: 1 }));
    store.setPrimary("core-cache");
    store.upsert(row("pool-cache", 1));

    let scans = 0;
    const hits: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = url(input);
      const auth = new Headers(init?.headers).get("authorization");

      if (target === CODEX_USAGE_ENDPOINT) {
        scans += 1;
        if (auth === "Bearer core-cache-access") return usage(80, 7_200);
        return usage(20, 600);
      }

      hits.push(auth ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);

    const first = await run("https://api.openai.com/v1/responses");
    await Bun.sleep(0);
    const second = await run("https://api.openai.com/v1/responses");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(scans).toBe(2);
    expect(hits).toEqual([
      "Bearer core-cache-access",
      "Bearer pool-cache-access",
    ]);
  });

  test("refresh clears a stale quota cache and falls back to core until usage is rewarmed", async () => {
    store.upsert(row("core-refresh", 0, { primary: 1 }));
    store.setPrimary("core-refresh");
    store.upsert(row("pool-refresh", 1));
    store.cacheQuota("core-refresh", 1);
    store.cacheQuota("pool-refresh", 0.1);

    let scans = 0;
    const hits: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = url(input);
      const auth = new Headers(init?.headers).get("authorization");

      if (target === CODEX_USAGE_ENDPOINT) {
        scans += 1;
        if (auth === "Bearer next-access") {
          return usage(80, 7_200);
        }

        return new Response("unused", { status: 500 });
      }

      if (target === "https://auth.openai.com/oauth/token") {
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

      hits.push(auth ?? "");

      if (auth === "Bearer core-refresh-access") {
        return new Response("unauthorized", {
          status: 401,
          statusText: "Unauthorized",
        });
      }

      if (auth === "Bearer next-access") {
        return new Response("core-ok", { status: 200 });
      }

      return new Response("pool-ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);

    const first = await run("https://api.openai.com/v1/responses");
    expect(store.quota("core-refresh", 60_000)).toBeUndefined();

    const second = await run("https://api.openai.com/v1/responses");
    await Bun.sleep(0);
    const third = await run("https://api.openai.com/v1/responses");

    expect(first.status).toBe(200);
    expect(await first.text()).toBe("core-ok");
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("core-ok");
    expect(third.status).toBe(200);
    expect(await third.text()).toBe("pool-ok");
    expect(scans).toBe(1);
    expect(hits).toEqual([
      "Bearer core-refresh-access",
      "Bearer next-access",
      "Bearer next-access",
      "Bearer pool-refresh-access",
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
