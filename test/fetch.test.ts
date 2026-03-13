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

interface Toast {
  title: string;
  message: string;
  variant: string;
  duration: number;
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
    plan_type: null,
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
  const toasts: Toast[] = [];
  return {
    calls,
    toasts,
    client: {
      auth: {
        set: async (input: unknown) => {
          calls.push(input);
          return {};
        },
      },
      tui: {
        showToast: async (input: { body: Toast }) => {
          toasts.push(input.body);
          return true;
        },
      },
    } as unknown as PluginInput["client"],
  };
}

function body(hit: Hit) {
  return JSON.parse(hit.body) as Record<string, unknown>;
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
  let now: typeof Date.now;

  beforeEach(() => {
    store = open(":memory:");
    old = globalThis.fetch;
    wait = globalThis.setTimeout;
    now = Date.now;
  });

  afterEach(() => {
    globalThis.fetch = old;
    globalThis.setTimeout = wait;
    Date.now = now;
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

  test("shows account scores in the toast when quota decides the winner", async () => {
    store.upsert(row("core-toast", 0, { primary: 1 }));
    store.setPrimary("core-toast");
    store.upsert(row("pool-toast", 1));
    store.cacheQuota("core-toast", 0.5);
    store.cacheQuota("pool-toast", 0.8);

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client, toasts } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses");

    expect(res.status).toBe(200);
    expect(toasts).toEqual([
      {
        title: "Codex Pool",
        message:
          "Fast-mode disabled\nReason: higher score\nAccounts:\n  [unknown] core-toast: 0.500\n> [unknown] pool-toast: 0.800",
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("shows warming state when quota scores are not cached yet", async () => {
    store.upsert(row("core-warm", 0, { primary: 1 }));
    store.setPrimary("core-warm");
    store.upsert(row("pool-warm", 1));

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (url(input) === CODEX_USAGE_ENDPOINT) {
        return usage({ plan_type: "plus", rate_limit: {} });
      }

      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client, toasts } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses");

    expect(res.status).toBe(200);
    expect(toasts).toEqual([
      {
        title: "Codex Pool",
        message:
          "Fast-mode disabled\nReason: quota cache warming\nAccounts:\n> [unknown] core-warm: n/a\n  [unknown] pool-warm: n/a",
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("shows the selection toast before sending the prompt request", async () => {
    store.upsert(row("core-before", 0, { primary: 1 }));
    store.setPrimary("core-before");
    store.upsert(row("pool-before", 1));
    store.cacheQuota("core-before", 0.5);
    store.cacheQuota("pool-before", 0.8);

    const { client, toasts } = stub();
    let prompt = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (url(input) === CODEX_API_ENDPOINT) {
        expect(toasts).toHaveLength(1);
        expect(toasts[0]?.message).toBe(
          "Fast-mode disabled\nReason: higher score\nAccounts:\n  [unknown] core-before: 0.500\n> [unknown] pool-before: 0.800",
        );
        prompt = true;
      }

      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses");

    expect(res.status).toBe(200);
    expect(prompt).toBe(true);
  });

  test("resolves fast-mode before the prompt request toast", async () => {
    store.upsert(row("fast-before", 0));

    const { client, toasts } = stub();
    let prompt = false;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (url(input) === CODEX_USAGE_ENDPOINT) {
        expect(toasts).toHaveLength(0);
        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 79,
              reset_after_seconds: 900,
              limit_window_seconds: 9_000,
            },
          },
        });
      }

      expect(url(input)).toBe(CODEX_API_ENDPOINT);
      expect(toasts).toHaveLength(1);
      expect(toasts[0]?.message).toBe(
          "Fast-mode enabled\nReason: only available account\nAccount:\n> [unknown] fast-before: n/a",
      );
      expect(body(await snap(input, init)).service_tier).toBe("priority");
      prompt = true;
      return new Response(await new Response(init?.body).text(), { status: 200 });
    }) as typeof fetch;

    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(prompt).toBe(true);
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

  test("shows failover reason in the toast after a 429", async () => {
    store.upsert(row("core-429", 0, { primary: 1 }));
    store.setPrimary("core-429");
    store.upsert(row("pool-429", 1));
    store.cacheQuota("core-429", 0.9);
    store.cacheQuota("pool-429", 0.4);

    let hits = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      hits += 1;
      if (hits === 1) {
        return new Response("slow", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "1" },
        });
      }

      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client, toasts } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses");

    expect(res.status).toBe(200);
    expect(toasts).toEqual([
      {
        title: "Codex Pool",
        message:
          "Fast-mode disabled\nReason: higher score\nAccounts:\n> [unknown] core-429: 0.900\n  [unknown] pool-429: 0.400",
        variant: "info",
        duration: 10_000,
      },
      {
        title: "Codex Pool",
        message:
          "Fast-mode disabled\nReason: core-429 hit 429 cooldown\nAccounts:\n  [unknown] core-429: 0.900\n> [unknown] pool-429: 0.400",
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("aligns account names and plan labels in the toast list", async () => {
    store.upsert(
      row("core-align", 0, {
        primary: 1,
        label: "account1@foobar.com",
        plan_type: "plus",
      }),
    );
    store.setPrimary("core-align");
    store.upsert(
      row("pool-align", 1, {
        label: "account2@a.com",
        plan_type: "pro",
      }),
    );
    store.cacheQuota("core-align", 0.5);
    store.cacheQuota("pool-align", 0.8);

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client, toasts } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses");

    expect(res.status).toBe(200);
    expect(toasts).toEqual([
      {
        title: "Codex Pool",
        message:
          "Fast-mode disabled\nReason: higher score\nAccounts:\n  [plus] account1@foobar.com: 0.500\n> [pro]  account2@a.com     : 0.800",
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("requests without prompt_cache_key do not keep sticky affinity", async () => {
    store.upsert(row("core-no-session", 0, { primary: 1 }));
    store.setPrimary("core-no-session");
    store.upsert(row("pool-no-session", 1));

    store.cacheQuota("core-no-session", 0.5);
    store.cacheQuota("pool-no-session", 0.55);

    const hits: string[] = [];
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const auth = new Headers(init?.headers).get("authorization");
      hits.push(auth ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);

    await run("https://api.openai.com/v1/responses");

    store.cacheQuota("core-no-session", 0.56);
    store.cacheQuota("pool-no-session", 0.55);

    await run("https://api.openai.com/v1/responses");

    expect(hits).toEqual([
      "Bearer pool-no-session-access",
      "Bearer core-no-session-access",
    ]);
  });

  test("toast only shows compared core and pool scores", async () => {
    store.upsert(row("core-compare", 0, { primary: 1 }));
    store.setPrimary("core-compare");
    store.upsert(row("pool-first", 1));
    store.upsert(row("pool-second", 2));
    store.cacheQuota("core-compare", 0.5);
    store.cacheQuota("pool-first", 0.8);
    store.cacheQuota("pool-second", 1.2);

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client, toasts } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses");

    expect(res.status).toBe(200);
    expect(toasts).toEqual([
      {
        title: "Codex Pool",
        message:
          "Fast-mode disabled\nReason: higher score\nAccounts:\n  [unknown] core-compare: 0.500\n> [unknown] pool-first  : 0.800",
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("toast marks the winning fallback account after multi-pool failover", async () => {
    store.upsert(row("core-fallback", 0, { primary: 1 }));
    store.setPrimary("core-fallback");
    store.upsert(row("pool-first-fallback", 1));
    store.upsert(row("pool-second-fallback", 2));
    store.cacheQuota("core-fallback", 0.9);
    store.cacheQuota("pool-first-fallback", 0.8);

    let hits = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      hits += 1;
      if (hits < 3) {
        return new Response("slow", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "1" },
        });
      }

      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client, toasts } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses");

    expect(res.status).toBe(200);
    expect(toasts).toEqual([
      {
        title: "Codex Pool",
        message:
          "Fast-mode disabled\nReason: higher score\nAccounts:\n> [unknown] core-fallback      : 0.900\n  [unknown] pool-first-fallback: 0.800",
        variant: "info",
        duration: 10_000,
      },
      {
        title: "Codex Pool",
        message:
          "Fast-mode disabled\nReason: core-fallback hit 429 cooldown\nAccounts:\n  [unknown] core-fallback      : 0.900\n> [unknown] pool-first-fallback: 0.800",
        variant: "info",
        duration: 10_000,
      },
      {
        title: "Codex Pool",
        message:
          "Fast-mode disabled\nReason: pool-first-fallback hit 429 cooldown\nAccounts:\n  [unknown] core-fallback       : 0.900\n  [unknown] pool-first-fallback : 0.800\n> [unknown] pool-second-fallback: n/a",
        variant: "info",
        duration: 10_000,
      },
    ]);
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

  test("injects priority service tier when fresh quota is under-burned", async () => {
    store.upsert(row("fast-on", 0));

    const hits: Hit[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (url(input) === CODEX_USAGE_ENDPOINT) {
        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 79,
              reset_after_seconds: 900,
              limit_window_seconds: 9_000,
            },
          },
        });
      }

      hits.push(await snap(input, init));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);
    await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      headers: { "content-type": "application/json" },
    });
    await Bun.sleep(0);
    hits.length = 0;

    const res = await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(body(hits[0])).toEqual({
      model: "gpt-5",
      input: "hi",
      service_tier: "priority",
    });
  });

  test("keeps 5h windows more conservative than 7d windows at the same progress", async () => {
    store.upsert(row("fast-window-5h", 0));

    const hits: Hit[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (url(input) === CODEX_USAGE_ENDPOINT) {
        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 43,
              reset_after_seconds: 9_000,
              limit_window_seconds: 18_000,
            },
          },
        });
      }

      hits.push(await snap(input, init));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);
    await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      headers: { "content-type": "application/json" },
    });
    await Bun.sleep(0);
    hits.length = 0;

    const res = await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(body(hits[0])).toEqual({ model: "gpt-5", input: "hi" });
  });

  test("allows 7d windows to enable fast-mode with less slack at the same progress", async () => {
    store.upsert(row("fast-window-7d", 0));

    const hits: Hit[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (url(input) === CODEX_USAGE_ENDPOINT) {
        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 43,
              reset_after_seconds: 302_400,
              limit_window_seconds: 604_800,
            },
          },
        });
      }

      hits.push(await snap(input, init));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);
    await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      headers: { "content-type": "application/json" },
    });
    await Bun.sleep(0);
    hits.length = 0;

    const res = await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(body(hits[0])).toEqual({
      model: "gpt-5",
      input: "hi",
      service_tier: "priority",
    });
  });

  test("relaxes the 5h threshold as the window approaches reset", async () => {
    store.upsert(row("fast-window-late", 0));

    const hits: Hit[] = [];
    let usageHits = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (url(input) === CODEX_USAGE_ENDPOINT) {
        usageHits += 1;
        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: usageHits === 1 ? 42 : 82,
              reset_after_seconds: usageHits === 1 ? 9_000 : 1_800,
              limit_window_seconds: 18_000,
            },
          },
        });
      }

      hits.push(await snap(input, init));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);
    const base = Date.now();
    Date.now = () => base;
    await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      headers: { "content-type": "application/json" },
    });
    await Bun.sleep(0);
    hits.length = 0;

    const first = await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      headers: { "content-type": "application/json" },
    });

    expect(first.status).toBe(200);
    expect(body(hits[0])).toEqual({ model: "gpt-5", input: "hi" });

    Date.now = () => base + 60_001;
    hits.length = 0;

    const second = await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      headers: { "content-type": "application/json" },
    });

    expect(second.status).toBe(200);
    expect(body(hits[0])).toEqual({
      model: "gpt-5",
      input: "hi",
      service_tier: "priority",
    });
  });

  test("shows fast-mode enabled in the account switch toast", async () => {
    store.upsert(row("fast-toast", 0));

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (url(input) === CODEX_USAGE_ENDPOINT) {
        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 79,
              reset_after_seconds: 900,
              limit_window_seconds: 9_000,
            },
          },
        });
      }

      return new Response(await new Response(init?.body).text(), { status: 200 });
    }) as typeof fetch;

    const { client, toasts } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(toasts).toEqual([
      {
        title: "Codex Pool",
        message:
          "Fast-mode enabled\nReason: only available account\nAccount:\n> [unknown] fast-toast: n/a",
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("does not flip fast-mode for the same session from stale cached usage alone", async () => {
    store.upsert(row("fast-flip", 0));

    let usageHits = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (url(input) === CODEX_USAGE_ENDPOINT) {
        usageHits += 1;
        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: usageHits === 1 ? 79 : 82,
              reset_after_seconds: usageHits === 1 ? 900 : 1_000,
              limit_window_seconds: 9_000,
            },
          },
        });
      }

      return new Response(await new Response(init?.body).text(), { status: 200 });
    }) as typeof fetch;

    const { client, toasts } = stub();
    const run = createFetch(store, async () => auth(), client);
    const base = Date.now();
    Date.now = () => base;

    const request = {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5",
        input: "hi",
        prompt_cache_key: "session-fast-flip",
      }),
      headers: { "content-type": "application/json" },
    } satisfies RequestInit;

    const first = await run("https://api.openai.com/v1/responses", request);
    expect(first.status).toBe(200);

    Date.now = () => base + 60_001;

    const second = await run("https://api.openai.com/v1/responses", request);
    expect(second.status).toBe(200);
    expect(toasts).toEqual([
      {
        title: "Codex Pool",
        message:
          "Fast-mode enabled\nReason: only available account\nAccount:\n> [unknown] fast-flip: n/a",
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("does not flip from disabled to enabled until usage is rewarmed", async () => {
    store.upsert(row("fast-flip-up", 0));

    let usageHits = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (url(input) === CODEX_USAGE_ENDPOINT) {
        usageHits += 1;
        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: usageHits === 1 ? 82 : 79,
              reset_after_seconds: usageHits === 1 ? 1_000 : 900,
              limit_window_seconds: 9_000,
            },
          },
        });
      }

      return new Response(await new Response(init?.body).text(), { status: 200 });
    }) as typeof fetch;

    const { client, toasts } = stub();
    const run = createFetch(store, async () => auth(), client);
    const base = Date.now();
    Date.now = () => base;

    const request = {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5",
        input: "hi",
        prompt_cache_key: "session-fast-flip-up",
      }),
      headers: { "content-type": "application/json" },
    } satisfies RequestInit;

    const first = await run("https://api.openai.com/v1/responses", request);
    expect(first.status).toBe(200);

    Date.now = () => base + 60_001;

    const second = await run("https://api.openai.com/v1/responses", request);
    expect(second.status).toBe(200);
    expect(toasts).toEqual([
      {
        title: "Codex Pool",
        message:
          "Fast-mode disabled\nReason: only available account\nAccount:\n> [unknown] fast-flip-up: n/a",
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("does not show a fast-mode flip toast after affinity expires", async () => {
    store.upsert(row("fast-expire", 0));

    let usageHits = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (url(input) === CODEX_USAGE_ENDPOINT) {
        usageHits += 1;
        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: usageHits === 1 ? 79 : 82,
              reset_after_seconds: usageHits === 1 ? 900 : 1_000,
              limit_window_seconds: 9_000,
            },
          },
        });
      }

      return new Response(await new Response(init?.body).text(), { status: 200 });
    }) as typeof fetch;

    const { client, toasts } = stub();
    const run = createFetch(store, async () => auth(), client);
    const base = Date.now();
    Date.now = () => base;

    const request = {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5",
        input: "hi",
        prompt_cache_key: "session-fast-expire",
      }),
      headers: { "content-type": "application/json" },
    } satisfies RequestInit;

    const first = await run("https://api.openai.com/v1/responses", request);
    expect(first.status).toBe(200);

    Date.now = () => base + 300_001;

    const second = await run("https://api.openai.com/v1/responses", request);
    expect(second.status).toBe(200);
    expect(toasts).toEqual([
      {
        title: "Codex Pool",
        message:
          "Fast-mode enabled\nReason: only available account\nAccount:\n> [unknown] fast-expire: n/a",
        variant: "info",
        duration: 10_000,
      },
      {
        title: "Codex Pool",
        message:
          "Fast-mode enabled\nReason: only available account\nAccount:\n> [plus] fast-expire: 4.696 cached",
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("skips priority injection when fresh quota falls below the weighted threshold", async () => {
    store.upsert(row("fast-off", 0));

    const hits: Hit[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (url(input) === CODEX_USAGE_ENDPOINT) {
        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 84,
              reset_after_seconds: 1_000,
              limit_window_seconds: 9_000,
            },
          },
        });
      }

      hits.push(await snap(input, init));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);
    await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      headers: { "content-type": "application/json" },
    });
    await Bun.sleep(0);
    hits.length = 0;

    const res = await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(body(hits[0])).toEqual({ model: "gpt-5", input: "hi" });
  });

  test("respects caller provided service_tier", async () => {
    store.upsert(row("tier-snake", 0));

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
      body: JSON.stringify({
        model: "gpt-5",
        input: "hi",
        service_tier: "auto",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(body(hits[0])).toEqual({
      model: "gpt-5",
      input: "hi",
      service_tier: "auto",
    });
  });

  test("respects caller provided serviceTier", async () => {
    store.upsert(row("tier-camel", 0));

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
      body: JSON.stringify({
        model: "gpt-5",
        input: "hi",
        serviceTier: "auto",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(body(hits[0])).toEqual({
      model: "gpt-5",
      input: "hi",
      serviceTier: "auto",
    });
  });

  test("does not use stale score cache when fresh usage cannot be loaded", async () => {
    store.upsert(row("stale-only", 0));
    store.cacheQuota("stale-only", 0.9);

    const hits: Hit[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (url(input) === CODEX_USAGE_ENDPOINT) {
        return new Response("nope", { status: 500 });
      }

      hits.push(await snap(input, init));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(body(hits[0])).toEqual({ model: "gpt-5", input: "hi" });
  });

  test("rebuilds the body per attempt during failover", async () => {
    store.upsert(row("fail-a", 0, { primary: 1 }));
    store.setPrimary("fail-a");
    store.upsert(row("fail-b", 1));

    const hits: Hit[] = [];
    let warm = true;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = url(input);
      const auth = new Headers(init?.headers).get("authorization");

      if (target === CODEX_USAGE_ENDPOINT) {
        if (auth === "Bearer fail-a-access") {
          return usage({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 79,
                reset_after_seconds: 900,
                limit_window_seconds: 9_000,
              },
            },
          });
        }

        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 84,
              reset_after_seconds: 1_100,
              limit_window_seconds: 9_000,
            },
          },
        });
      }

      hits.push(await snap(input, init));
      if (warm) {
        return new Response("ok", { status: 200 });
      }

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
    await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      headers: { "content-type": "application/json" },
    });
    await Bun.sleep(0);
    warm = false;
    hits.length = 0;

    const res = await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(hits.map((item) => body(item))).toEqual([
      { model: "gpt-5", input: "hi", service_tier: "priority" },
      { model: "gpt-5", input: "hi" },
    ]);
  });

  test("keeps Request bodies unchanged across failover when they are not JSON", async () => {
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
    const req = new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      body: "native-body",
      headers: { "content-type": "text/plain" },
    });
    const res = await run(req);

    expect(res.status).toBe(200);
    expect(hits.map((item) => item.body)).toEqual(["native-body", "native-body"]);
  });

  test("uses the most conservative delta across additional rate limits", async () => {
    store.upsert(row("fast-conservative", 0));

    const hits: Hit[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (url(input) === CODEX_USAGE_ENDPOINT) {
        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 79,
              reset_after_seconds: 900,
              limit_window_seconds: 9_000,
            },
          },
          additional_rate_limits: [
            {
              rate_limit: {
                primary_window: {
                  used_percent: 84,
                  reset_after_seconds: 1_000,
                  limit_window_seconds: 9_000,
                },
              },
            },
          ],
        });
      }

      hits.push(await snap(input, init));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);
    await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      headers: { "content-type": "application/json" },
    });
    await Bun.sleep(0);
    hits.length = 0;

    const res = await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(body(hits[0])).toEqual({ model: "gpt-5", input: "hi" });
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

  test("prioritizes untouched first-use windows to start their clock", async () => {
    store.upsert(row("core-dormant", 0, { primary: 1 }));
    store.setPrimary("core-dormant");
    store.upsert(row("pool-active", 1));

    const hits: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = url(input);
      const auth = new Headers(init?.headers).get("authorization");

      if (target === CODEX_USAGE_ENDPOINT) {
        if (auth === "Bearer core-dormant-access") {
          return usage({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 0,
                reset_after_seconds: 18_000,
                limit_window_seconds: 18_000,
              },
            },
          });
        }

        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 25,
              reset_after_seconds: 14_400,
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
      "Bearer core-dormant-access",
      "Bearer core-dormant-access",
    ]);
  });

  test("treats zero-used windows as active once their countdown has started", async () => {
    store.upsert(row("core-started", 0, { primary: 1 }));
    store.setPrimary("core-started");
    store.upsert(row("pool-started", 1));

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (url(input) === CODEX_USAGE_ENDPOINT) {
        const auth = new Headers(init?.headers).get("authorization");
        if (auth === "Bearer core-started-access") {
          return usage({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 0,
                reset_after_seconds: 1_800,
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
              reset_after_seconds: 14_400,
              limit_window_seconds: 18_000,
            },
          },
        });
      }

      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);

    await run("https://api.openai.com/v1/responses");
    await Bun.sleep(0);

    expect(store.quota("core-started", 60_000)).toBeGreaterThan(1000);
  });

  test("stops treating untouched windows as dormant after the slack threshold", async () => {
    store.upsert(row("core-slack", 0, { primary: 1 }));
    store.setPrimary("core-slack");
    store.upsert(row("pool-slack", 1));

    const hits: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = url(input);
      const auth = new Headers(init?.headers).get("authorization");

      if (target === CODEX_USAGE_ENDPOINT) {
        if (auth === "Bearer core-slack-access") {
          return usage({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 0,
                reset_after_seconds: 17_939,
                limit_window_seconds: 18_000,
              },
            },
          });
        }

        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 25,
              reset_after_seconds: 14_400,
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
      "Bearer core-slack-access",
      "Bearer pool-slack-access",
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
                used_percent: 99.8,
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

  test("expired quota cache uses stale scores for ordering while refreshing in background", async () => {
    store.upsert(row("core-stale", 0, { primary: 1 }));
    store.setPrimary("core-stale");
    store.upsert(row("pool-stale", 1));

    const staleAt = Date.now() - 120_000;
    store.cacheQuota("core-stale", 0.5, staleAt);
    store.cacheQuota("pool-stale", 0.8, staleAt);

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
        if (auth === "Bearer core-stale-access") return usage(50, 600);
        return usage(30, 600);
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
      "Bearer pool-stale-access",
      "Bearer pool-stale-access",
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

  test("sticky affinity keeps the same account when scores are close", async () => {
    store.upsert(row("core-sticky", 0, { primary: 1 }));
    store.setPrimary("core-sticky");
    store.upsert(row("pool-sticky", 1));

    store.cacheQuota("core-sticky", 0.5);
    store.cacheQuota("pool-sticky", 0.55);

    const hits: string[] = [];
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const auth = new Headers(init?.headers).get("authorization");
      hits.push(auth ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client, toasts } = stub();
    const run = createFetch(store, async () => auth(), client);
    const body = JSON.stringify({ prompt_cache_key: "ses-sticky" });

    await run("https://api.openai.com/v1/responses", { body });

    // pool wins first request (no affinity, 0.55 > 0.5), affinity set to pool
    // flip scores so core is now slightly better
    store.cacheQuota("core-sticky", 0.56);
    store.cacheQuota("pool-sticky", 0.55);

    await run("https://api.openai.com/v1/responses", { body });

    // core 0.56 does NOT exceed pool 0.55 * 1.2 = 0.66, so affinity holds
    expect(hits).toEqual([
      "Bearer pool-sticky-access",
      "Bearer pool-sticky-access",
    ]);
    expect(toasts).toHaveLength(1);
  });

  test("sticky affinity yields when alternative score exceeds margin", async () => {
    store.upsert(row("core-yield", 0, { primary: 1 }));
    store.setPrimary("core-yield");
    store.upsert(row("pool-yield", 1));

    store.cacheQuota("core-yield", 0.5);
    store.cacheQuota("pool-yield", 0.55);

    const hits: string[] = [];
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const auth = new Headers(init?.headers).get("authorization");
      hits.push(auth ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);
    const body = JSON.stringify({ prompt_cache_key: "ses-yield" });

    await run("https://api.openai.com/v1/responses", { body });

    // pool wins first request → affinity = pool
    // core is now much better (exceeds pool * 1.2)
    store.cacheQuota("core-yield", 0.8);
    store.cacheQuota("pool-yield", 0.55);

    await run("https://api.openai.com/v1/responses", { body });

    // core 0.8 > pool 0.55 * 1.2 = 0.66 → switch to core
    expect(hits).toEqual([
      "Bearer pool-yield-access",
      "Bearer core-yield-access",
    ]);
  });

  test("sticky affinity yields when current account is blocked", async () => {
    store.upsert(row("core-block", 0, { primary: 1 }));
    store.setPrimary("core-block");
    store.upsert(row("pool-block", 1));

    store.cacheQuota("core-block", 0.5);
    store.cacheQuota("pool-block", 0.3);

    const hits: string[] = [];
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const auth = new Headers(init?.headers).get("authorization");
      hits.push(auth ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);
    const body = JSON.stringify({ prompt_cache_key: "ses-block" });

    await run("https://api.openai.com/v1/responses", { body });

    // core wins first request → affinity = core
    // core becomes blocked (score 0)
    store.cacheQuota("core-block", 0);
    store.cacheQuota("pool-block", 0.3);

    await run("https://api.openai.com/v1/responses", { body });

    // affinity is core but score is 0 → guard fails → standard comparison → pool wins
    expect(hits).toEqual([
      "Bearer core-block-access",
      "Bearer pool-block-access",
    ]);
  });

  test("different sessions get independent routing", async () => {
    store.upsert(row("core-ind", 0, { primary: 1 }));
    store.setPrimary("core-ind");
    store.upsert(row("pool-ind", 1));

    store.cacheQuota("core-ind", 0.5);
    store.cacheQuota("pool-ind", 0.55);

    const hits: string[] = [];
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const auth = new Headers(init?.headers).get("authorization");
      hits.push(auth ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);

    // session A: pool wins (0.55 > 0.5), sets affinity to pool for session A
    await run("https://api.openai.com/v1/responses", {
      body: JSON.stringify({ prompt_cache_key: "ses-A" }),
    });

    // flip scores so core is slightly better
    store.cacheQuota("core-ind", 0.56);
    store.cacheQuota("pool-ind", 0.55);

    // session B: no affinity for this session, standard comparison applies
    // core 0.56 > pool 0.55 → core wins
    await run("https://api.openai.com/v1/responses", {
      body: JSON.stringify({ prompt_cache_key: "ses-B" }),
    });

    // session A: affinity holds on pool despite core being slightly better
    await run("https://api.openai.com/v1/responses", {
      body: JSON.stringify({ prompt_cache_key: "ses-A" }),
    });

    expect(hits).toEqual([
      "Bearer pool-ind-access",
      "Bearer core-ind-access",
      "Bearer pool-ind-access",
    ]);
  });

  test("conservation dampens long-window account in favor of short-window account", async () => {
    store.upsert(row("core-long", 0, { primary: 1 }));
    store.setPrimary("core-long");
    store.upsert(row("pool-short", 1));

    const hits: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = url(input);
      const hdr = new Headers(init?.headers).get("authorization");

      if (target === CODEX_USAGE_ENDPOINT) {
        if (hdr === "Bearer core-long-access") {
          return usage({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 85,
                reset_after_seconds: 518_400,
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
              reset_after_seconds: 14_400,
              limit_window_seconds: 18_000,
            },
          },
        });
      }

      hits.push(hdr ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);

    await run("https://api.openai.com/v1/responses");
    await Bun.sleep(0);
    const second = await run("https://api.openai.com/v1/responses");

    expect(second.status).toBe(200);
    expect(hits).toEqual([
      "Bearer core-long-access",
      "Bearer pool-short-access",
    ]);
  });

  test("conservation allows aggressive burn of near-reset long window", async () => {
    store.upsert(row("core-expiring", 0, { primary: 1 }));
    store.setPrimary("core-expiring");
    store.upsert(row("pool-moderate", 1));

    const hits: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = url(input);
      const hdr = new Headers(init?.headers).get("authorization");

      if (target === CODEX_USAGE_ENDPOINT) {
        if (hdr === "Bearer core-expiring-access") {
          return usage({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 40,
                reset_after_seconds: 1_800,
                limit_window_seconds: 604_800,
              },
            },
          });
        }

        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 40,
              reset_after_seconds: 14_400,
              limit_window_seconds: 18_000,
            },
          },
        });
      }

      hits.push(hdr ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);

    await run("https://api.openai.com/v1/responses");
    await Bun.sleep(0);
    const second = await run("https://api.openai.com/v1/responses");

    expect(second.status).toBe(200);
    expect(hits).toEqual([
      "Bearer core-expiring-access",
      "Bearer core-expiring-access",
    ]);
  });

  test("conservation factor is capped at horizon", async () => {
    store.upsert(row("core-extreme", 0, { primary: 1 }));
    store.setPrimary("core-extreme");
    store.upsert(row("pool-normal", 1));

    const hits: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = url(input);
      const hdr = new Headers(init?.headers).get("authorization");

      if (target === CODEX_USAGE_ENDPOINT) {
        if (hdr === "Bearer core-extreme-access") {
          return usage({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 80,
                reset_after_seconds: 2_592_000,
                limit_window_seconds: 2_592_000,
              },
            },
          });
        }

        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 50,
              reset_after_seconds: 14_400,
              limit_window_seconds: 18_000,
            },
          },
        });
      }

      hits.push(hdr ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);

    await run("https://api.openai.com/v1/responses");
    await Bun.sleep(0);
    const second = await run("https://api.openai.com/v1/responses");

    expect(second.status).toBe(200);
    expect(hits).toEqual([
      "Bearer core-extreme-access",
      "Bearer pool-normal-access",
    ]);
  });

  test("adaptive switch margin breaks affinity sooner when scores diverge", async () => {
    store.upsert(row("core-am", 0, { primary: 1 }));
    store.setPrimary("core-am");
    store.upsert(row("pool-am", 1));

    store.cacheQuota("core-am", 0.1);
    store.cacheQuota("pool-am", 0.12);

    const hits: string[] = [];
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const hdr = new Headers(init?.headers).get("authorization");
      hits.push(hdr ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);
    const body = JSON.stringify({ prompt_cache_key: "ses-am" });

    // pool wins first (0.12 > 0.10), affinity = pool
    await run("https://api.openai.com/v1/responses", { body });

    // flip: core 0.12, pool 0.10
    // fixed 0.2 margin: 0.12 > 0.10 * 1.2 = 0.12 → false (not strict >)
    // adaptive margin: balance = 0.833, margin ≈ 0.183 → 0.12 > 0.1183 → true
    store.cacheQuota("core-am", 0.12);
    store.cacheQuota("pool-am", 0.1);

    await run("https://api.openai.com/v1/responses", { body });

    expect(hits).toEqual([
      "Bearer pool-am-access",
      "Bearer core-am-access",
    ]);
  });
});
