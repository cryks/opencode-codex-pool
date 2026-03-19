import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk";

import {
  createFetch,
  flushUsagePollers,
  resetUsagePollers,
} from "../src/fetch";
import { open } from "../src/store";
import type { Store } from "../src/store";
import {
  CAPACITY_REF,
  CODEX_API_ENDPOINT,
  CODEX_USAGE_ENDPOINT,
  REFRESH_LEASE_MS,
} from "../src/types";
import type { Account, Usage } from "../src/types";

const PRO_PLAN_WEIGHT = Math.sqrt(6.7);

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

function fastToast(
  fast: boolean,
  detail: string,
  because: string,
  rule: string,
  rows: string[] = [],
  target?: string,
  _account?: string,
) {
  const signed = (value: string) => {
    const num = Number(value);
    return `${num >= 0 ? "+" : ""}${num.toFixed(3)}`;
  };
  const last = (line?: string) => /([+-]?\d+\.\d+)$/.exec(line ?? "")?.[1];
  const main = /main\s+(\S+)\s+([+-]\d+\.\d+)$/.exec(
    rows.find((line) => line.startsWith("main")) ?? "",
  );
  const final = last(rows.find((line) => line.startsWith("= final")));
  const guard = last(rows.find((line) => line.startsWith("- guard")));
  const note = (() => {
    if (fast) {
      if (final && main && guard && Number(guard) > 0) {
        return `Fast: enabled (${signed(final)} = main ${main[1]} ${main[2]} - guard ${Number(guard).toFixed(3)})`;
      }
      if (final) return `Fast: enabled (${signed(final)})`;
      return "Fast: enabled";
    }

    if (rule === "manual") return "Fast: disabled (manual tier)";
    if (rule === "blocked") return "Fast: disabled (blocked)";
    if (rule === "no data") return "Fast: disabled (no data)";
    if (rule === "low cap") {
      return target ? `Fast: disabled (cap<3%, ${target})` : "Fast: disabled (cap<3%)";
    }
    if (rule === "low score" && final) {
      if (main && guard && Number(guard) > 0) {
        return `Fast: disabled (low score ${signed(final)} = main ${main[1]} ${main[2]} - guard ${Number(guard).toFixed(3)})`;
      }
      return `Fast: disabled (low score ${signed(final)})`;
    }
    return `Fast: disabled (${rule})`;
  })();

  const lines = [detail, `Because: ${because}`, "", note];

  return lines.join("\n");
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

function scored(score: number, plan = "plus"): Usage {
  if (score === 0) {
    return {
      plan_type: plan,
      rate_limit: {
        allowed: false,
      },
    };
  }

  const weight = plan === "pro" ? PRO_PLAN_WEIGHT : 1;
  const span = CAPACITY_REF * (score / weight) ** 2;
  return {
    plan_type: plan,
    rate_limit: {
      primary_window: {
        used_percent: 0,
        reset_after_seconds: span,
        limit_window_seconds: span,
      },
    },
  };
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
    resetUsagePollers();
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
    store.cacheUsage("core-toast", scored(0.5));
    store.cacheUsage("pool-toast", scored(0.8));

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
        message: fastToast(
          false,
          "Accounts:\n  [unknown] core-toast:\n    [7.5m] 0.500\n> [unknown] pool-toast:\n    [19.2m] 0.800",
          "higher score",
          "no data",
          [],
          "request body",
          "pool-toast",
        ),
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("shows all window scores in the toast when multiple windows exist", async () => {
    store.upsert(row("core-secondary", 0, { primary: 1 }));
    store.setPrimary("core-secondary");
    store.upsert(row("pool-secondary", 1));
    store.cacheUsage("core-secondary", {
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 10,
          reset_after_seconds: 18_000,
          limit_window_seconds: 18_000,
        },
        secondary_window: {
          used_percent: 90,
          reset_after_seconds: 604_800,
          limit_window_seconds: 604_800,
        },
      },
    });
    store.cacheUsage("pool-secondary", scored(0.8));

    globalThis.fetch = (async () => {
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const { client, toasts } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses");

    expect(res.status).toBe(200);
    expect(toasts[0]?.message).toContain("core-secondary:");
    expect(toasts[0]?.message).not.toContain("final ");
    expect(toasts[0]?.message).toContain("[guard]");
    expect(toasts[0]?.message).toContain("(");
    expect(toasts[0]?.message).toContain(" * [guard] x");
    expect(toasts[0]?.message).not.toContain("[guard 5h]");
    expect(toasts[0]?.message).not.toContain("[main 7d]");
    expect(toasts[0]?.message).not.toContain("[main]");
  });

  test("uses the longest rate window for ranking and applies the shorter window as a guard", async () => {
    store.upsert(row("core-guard-rank", 0, { primary: 1 }));
    store.setPrimary("core-guard-rank");
    store.upsert(row("pool-steady-rank", 1));
    store.cacheUsage("core-guard-rank", {
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 90,
          reset_after_seconds: 15_000,
          limit_window_seconds: 18_000,
        },
        secondary_window: {
          used_percent: 10,
          reset_after_seconds: 483_840,
          limit_window_seconds: 604_800,
        },
      },
    });
    store.cacheUsage("pool-steady-rank", {
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 35,
          reset_after_seconds: 302_400,
          limit_window_seconds: 604_800,
        },
      },
    });

    const hits: Hit[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      hits.push(await snap(input, init));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client, toasts } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses");

    expect(res.status).toBe(200);
    expect(hits[0]?.auth).toBe("Bearer pool-steady-rank-access");
    expect(toasts[0]?.message).not.toContain("final ");
    expect(toasts[0]?.message).toContain("[guard]");
    expect(toasts[0]?.message).toContain(" * [guard] x");
    expect(toasts[0]?.message).not.toContain("[main 7d]");
    expect(toasts[0]?.message).not.toContain("[guard 5h]");
    expect(toasts[0]?.message).not.toContain("[main]");
    expect(toasts[0]?.message).toContain("core-guard-rank:");
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
        message: fastToast(
          false,
          "Accounts:\n> [unknown] core-warm: n/a\n  [unknown] pool-warm: n/a",
          "quota cache warming",
          "no data",
          [],
          "request body",
          "core-warm",
        ),
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("fetches fresh usage for expired cache entries before ranking and showing the selection toast", async () => {
    store.upsert(row("core-expired", 0, { primary: 1 }));
    store.setPrimary("core-expired");
    store.upsert(row("pool-expired", 1));

    const expiredAt = Date.now() - 3_600_001;
    store.cacheUsage("core-expired", scored(0.9), expiredAt);
    store.cacheUsage("pool-expired", scored(0.1), expiredAt);

    const hits: string[] = [];
    const { client, toasts } = stub();
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = url(input);
      const auth = new Headers(init?.headers).get("authorization");

      if (target === CODEX_USAGE_ENDPOINT) {
        hits.push(`usage:${auth ?? ""}`);
        if (auth === "Bearer core-expired-access") {
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
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 30,
              reset_after_seconds: 600,
              limit_window_seconds: 18_000,
            },
          },
        });
      }

      expect(toasts).toHaveLength(2);
      hits.push(`prompt:${auth ?? ""}`);
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses");

    expect(res.status).toBe(200);
    expect(hits).toEqual([
      "usage:Bearer core-expired-access",
      "usage:Bearer pool-expired-access",
      "prompt:Bearer pool-expired-access",
    ]);
    expect(toasts).toEqual([
      {
        title: "Codex Pool",
        message: "Quota cache expired, fetching usage before selection",
        variant: "info",
        duration: 10_000,
      },
      {
        title: "Codex Pool",
        message: fastToast(
          false,
          "Accounts:\n  [unknown] core-expired:\n    [5h] 53.126\n> [unknown] pool-expired:\n    [5h] 74.377",
          "higher score",
          "no data",
          [],
          "request body",
          "pool-expired",
        ),
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("fetches fresh usage when a cached reset window appears elapsed before ranking and showing the selection toast", async () => {
    store.upsert(row("core-reset", 0, { primary: 1 }));
    store.setPrimary("core-reset");
    store.upsert(row("pool-reset", 1));

    const base = Date.now();
    store.cacheUsage(
      "core-reset",
      {
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: 10,
            reset_after_seconds: 10,
          },
        },
      },
      base,
    );
    store.cacheUsage(
      "pool-reset",
      {
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: 90,
            reset_after_seconds: 10,
          },
        },
      },
      base,
    );
    Date.now = () => base + 30_000;

    const hits: string[] = [];
    const { client, toasts } = stub();
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = url(input);
      const auth = new Headers(init?.headers).get("authorization");

      if (target === CODEX_USAGE_ENDPOINT) {
        hits.push(`usage:${auth ?? ""}`);
        if (auth === "Bearer core-reset-access") {
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
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 30,
              reset_after_seconds: 600,
              limit_window_seconds: 18_000,
            },
          },
        });
      }

      expect(toasts).toHaveLength(2);
      hits.push(`prompt:${auth ?? ""}`);
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses");

    expect(res.status).toBe(200);
    expect(hits).toEqual([
      "usage:Bearer core-reset-access",
      "usage:Bearer pool-reset-access",
      "prompt:Bearer pool-reset-access",
    ]);
    expect(toasts).toEqual([
      {
        title: "Codex Pool",
        message: "Quota cache expired, fetching usage before selection",
        variant: "info",
        duration: 10_000,
      },
      {
        title: "Codex Pool",
        message: fastToast(
          false,
          "Accounts:\n  [unknown] core-reset:\n    [5h] 53.126\n> [unknown] pool-reset:\n    [5h] 74.377",
          "higher score",
          "no data",
          [],
          "request body",
          "pool-reset",
        ),
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("shows the selection toast before sending the prompt request", async () => {
    store.upsert(row("core-before", 0, { primary: 1 }));
    store.setPrimary("core-before");
    store.upsert(row("pool-before", 1));
    store.cacheUsage("core-before", scored(0.5));
    store.cacheUsage("pool-before", scored(0.8));

    const { client, toasts } = stub();
    let prompt = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (url(input) === CODEX_API_ENDPOINT) {
        expect(toasts).toHaveLength(1);
        expect(toasts[0]?.message).toBe(
          fastToast(
            false,
            "Accounts:\n  [unknown] core-before:\n    [7.5m] 0.500\n> [unknown] pool-before:\n    [19.2m] 0.800",
            "higher score",
            "no data",
            [],
            "request body",
            "pool-before",
          ),
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
    const hits: Hit[] = [];
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
          fastToast(
            true,
            "Account:\n> [unknown] fast-before: n/a",
            "only available account",
            "ok",
            [
              "main    rate.primary +0.806",
              "= base   [******  ] +0.806",
              "= final  [******  ] +0.806",
            ],
            undefined,
            "fast-before",
          ),
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
    store.cacheUsage("core-429", scored(0.9));
    store.cacheUsage("pool-429", scored(0.4));

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
        message: fastToast(
          false,
          "Accounts:\n> [unknown] core-429:\n    [24.3m] 0.900\n  [unknown] pool-429:\n    [4.8m] 0.400",
          "higher score",
          "no data",
          [],
          "request body",
          "core-429",
        ),
        variant: "info",
        duration: 10_000,
      },
      {
        title: "Codex Pool",
        message: fastToast(
          false,
          "Accounts:\n  [unknown] core-429:\n    [24.3m] 0.900\n> [unknown] pool-429:\n    [4.8m] 0.400",
          "core-429 hit 429 cooldown",
          "no data",
          [],
          "request body",
          "pool-429",
        ),
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("aligns account names, plan labels, and score decimals in the toast list", async () => {
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
    store.cacheUsage("core-align", scored(123.456));
    store.cacheUsage("pool-align", scored(4.567));

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
        message: fastToast(
          false,
          "Accounts:\n> [plus] account1@foobar.com:\n    [317.5d] 123.456\n  [pro]  account2@a.com:\n    [10.4h]   4.567",
          "higher score",
          "no data",
          [],
          "request body",
          "account1@foobar.com",
        ),
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("requests without prompt_cache_key do not keep sticky affinity", async () => {
    store.upsert(row("core-no-session", 0, { primary: 1 }));
    store.setPrimary("core-no-session");
    store.upsert(row("pool-no-session", 1));

    store.cacheUsage("core-no-session", scored(0.5));
    store.cacheUsage("pool-no-session", scored(0.55));

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

    store.cacheUsage("core-no-session", scored(0.56));
    store.cacheUsage("pool-no-session", scored(0.55));

    await run("https://api.openai.com/v1/responses");

    expect(hits).toEqual([
      "Bearer pool-no-session-access",
      "Bearer core-no-session-access",
    ]);
  });

  test("toast shows all accounts after multi-pool ranking", async () => {
    store.upsert(row("core-compare", 0, { primary: 1 }));
    store.setPrimary("core-compare");
    store.upsert(row("pool-first", 1));
    store.upsert(row("pool-second", 2));
    store.cacheUsage("core-compare", scored(0.5));
    store.cacheUsage("pool-first", scored(0.8));
    store.cacheUsage("pool-second", scored(1.2));

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
        message: fastToast(
          false,
          "Accounts:\n  [unknown] core-compare:\n    [7.5m] 0.500\n  [unknown] pool-first:\n    [19.2m] 0.800\n> [unknown] pool-second:\n    [43.2m] 1.200",
          "higher score",
          "no data",
          [],
          "request body",
          "pool-second",
        ),
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
    store.cacheUsage("core-fallback", scored(0.9));
    store.cacheUsage("pool-first-fallback", scored(0.8));
    store.cacheUsage("pool-second-fallback", scored(0.7));

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
        message: fastToast(
          false,
          "Accounts:\n> [unknown] core-fallback:\n    [24.3m] 0.900\n  [unknown] pool-first-fallback:\n    [19.2m] 0.800\n  [unknown] pool-second-fallback:\n    [14.7m] 0.700",
          "higher score",
          "no data",
          [],
          "request body",
          "core-fallback",
        ),
        variant: "info",
        duration: 10_000,
      },
      {
        title: "Codex Pool",
        message: fastToast(
          false,
          "Accounts:\n  [unknown] core-fallback:\n    [24.3m] 0.900\n> [unknown] pool-first-fallback:\n    [19.2m] 0.800\n  [unknown] pool-second-fallback:\n    [14.7m] 0.700",
          "core-fallback hit 429 cooldown",
          "no data",
          [],
          "request body",
          "pool-first-fallback",
        ),
        variant: "info",
        duration: 10_000,
      },
      {
        title: "Codex Pool",
        message: fastToast(
          false,
          "Accounts:\n  [unknown] core-fallback:\n    [24.3m] 0.900\n  [unknown] pool-first-fallback:\n    [19.2m] 0.800\n> [unknown] pool-second-fallback:\n    [14.7m] 0.700",
          "pool-first-fallback hit 429 cooldown",
          "no data",
          [],
          "request body",
          "pool-second-fallback",
        ),
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

  test("allows near-reset windows to enable fast-mode before capacity is stranded", async () => {
    store.upsert(row("fast-late", 0));

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
              used_percent: 90,
              reset_after_seconds: 900,
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
              used_percent: 19,
              reset_after_seconds: 14_400,
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

  test("keeps 7d windows aligned with the same score-normalized fast-mode gate", async () => {
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
              used_percent: 19,
              reset_after_seconds: 483_840,
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
    expect(body(hits[0])).toEqual({ model: "gpt-5", input: "hi" });
  });

  test("stale usage keeps the current request on cached fast-mode state while rewarming", async () => {
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
              used_percent: usageHits === 1 ? 19 : 79,
              reset_after_seconds: usageHits === 1 ? 14_400 : 900,
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
    expect(body(hits[0])).toEqual({ model: "gpt-5", input: "hi" });

    await Bun.sleep(0);
    hits.length = 0;

    const third = await run("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      headers: { "content-type": "application/json" },
    });

    expect(third.status).toBe(200);
    expect(body(hits[0])).toEqual({
      model: "gpt-5",
      input: "hi",
      service_tier: "priority",
    });
  });

  test("shows fast-mode enabled in the account switch toast", async () => {
    store.upsert(row("fast-toast", 0));

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
        message: fastToast(
          true,
          "Account:\n> [unknown] fast-toast: n/a",
            "only available account",
            "ok",
            [
              "main    rate.primary +0.806",
              "= base   [******  ] +0.806",
              "= final  [******  ] +0.806",
            ],
          undefined,
          "fast-toast",
        ),
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("uses the longest rate window as the fast-mode base and shorter windows as guards", async () => {
    store.upsert(row("fast-main-guard", 0));
    store.cacheUsage("fast-main-guard", {
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 0,
          reset_after_seconds: 18_000,
          limit_window_seconds: 18_000,
        },
        secondary_window: {
          used_percent: 79,
          reset_after_seconds: 60_480,
          limit_window_seconds: 604_800,
        },
      },
    });

    const hits: Hit[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      hits.push(await snap(input, init));
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
    expect(body(hits[0])).toEqual({
      model: "gpt-5",
      input: "hi",
      service_tier: "priority",
    });
    const message = toasts[0]?.message ?? "";
    expect(message).toContain("Fast: enabled (+0.806)");
    expect(message.endsWith("Fast: enabled (+0.806)")).toBe(true);
  });

  test("attributes multi-account fast-mode details to the selected account", async () => {
    store.upsert(row("core-fast-pick", 0, { primary: 1, plan_type: "plus" }));
    store.setPrimary("core-fast-pick");
    store.upsert(row("pool-fast-pick", 1, { plan_type: "plus" }));
    store.cacheUsage("core-fast-pick", {
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 98,
          reset_after_seconds: 900,
          limit_window_seconds: 18_000,
        },
      },
    });
    store.cacheUsage("pool-fast-pick", {
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 79,
          reset_after_seconds: 900,
          limit_window_seconds: 9_000,
        },
      },
    });

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
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
        message: fastToast(
          true,
          "Accounts:\n  [plus] core-fast-pick:\n    [5h] 1.231\n> [plus] pool-fast-pick:\n    [2.5h] 5.006",
            "higher score",
            "ok",
            [
              "main    rate.primary +0.806",
              "= base   [******  ] +0.806",
              "= final  [******  ] +0.806",
            ],
          undefined,
          "pool-fast-pick",
        ),
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("does not let untouched additional windows veto an active fast-mode decision", async () => {
    store.upsert(row("fast-extra", 0));

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
                  used_percent: 0,
                  reset_after_seconds: 604_800,
                  limit_window_seconds: 604_800,
                },
              },
            },
          ],
        });
      }

      hits.push(await snap(input, init));
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
    const message = toasts[0]?.message ?? "";
    expect(message).toContain("Fast: enabled (+0.806)");
    expect(message).not.toContain("additional 1");
    expect(body(hits[0])).toEqual({
      model: "gpt-5",
      input: "hi",
      service_tier: "priority",
    });
  });

  test("ignores additional rate limits when fast-mode has no rate_limit windows", async () => {
    store.upsert(row("fast-extra-only", 0));

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (url(input) === CODEX_USAGE_ENDPOINT) {
        return usage({
          plan_type: "plus",
          additional_rate_limits: [
            {
              rate_limit: {
                primary_window: {
                  used_percent: 0,
                  reset_after_seconds: 604_800,
                  limit_window_seconds: 604_800,
                },
              },
            },
          ],
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
    const message = toasts[0]?.message ?? "";
    expect(message).toContain("Fast: disabled (no data)");
    expect(message).not.toContain("additional 1 primary");
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
              used_percent: usageHits === 1 ? 79 : 98,
              reset_after_seconds: 900,
              limit_window_seconds: 18_000,
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
        message: fastToast(
          true,
          "Account:\n> [unknown] fast-flip: n/a",
            "only available account",
            "ok",
            [
              "main    rate.primary +1.527",
              "= base   [********] +1.527",
              "= final  [********] +1.527",
            ],
          undefined,
          "fast-flip",
        ),
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
              used_percent: usageHits === 1 ? 98 : 90,
              reset_after_seconds: 900,
              limit_window_seconds: 18_000,
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
        message: fastToast(
          false,
          "Account:\n> [unknown] fast-flip-up: n/a",
            "only available account",
            "low cap",
            [
              "need cap [*       ] 0.030",
            ],
          "rate.primary",
          "fast-flip-up",
        ),
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("keeps fast-mode on for the same sticky account inside the hysteresis band", async () => {
    store.upsert(row("fast-band", 0));

    let usageHits = 0;
    const hits: Hit[] = [];
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
              used_percent: usageHits === 1 ? 79 : 19,
              reset_after_seconds: usageHits === 1 ? 900 : 14_400,
              limit_window_seconds: usageHits === 1 ? 9_000 : 18_000,
            },
          },
        });
      }

      hits.push(await snap(input, init));
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
        prompt_cache_key: "session-fast-band",
      }),
      headers: { "content-type": "application/json" },
    } satisfies RequestInit;

    const first = await run("https://api.openai.com/v1/responses", request);
    expect(first.status).toBe(200);

    Date.now = () => base + 60_001;
    const second = await run("https://api.openai.com/v1/responses", request);
    expect(second.status).toBe(200);
    await Bun.sleep(0);

    hits.length = 0;
    const third = await run("https://api.openai.com/v1/responses", request);
    expect(third.status).toBe(200);
    expect(body(hits[0])).toEqual({
      model: "gpt-5",
      input: "hi",
      prompt_cache_key: "session-fast-band",
      service_tier: "priority",
    });
    expect(toasts).toHaveLength(1);
  });

  test("flips fast-mode off for the same sticky account after fresh profile pressure drops below the off threshold", async () => {
    store.upsert(row("fast-band-off", 0));

    let usageHits = 0;
    const hits: Hit[] = [];
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
              used_percent: usageHits === 1 ? 79 : 81,
              reset_after_seconds: usageHits === 1 ? 900 : 3_600,
              limit_window_seconds: usageHits === 1 ? 9_000 : 18_000,
            },
          },
        });
      }

      hits.push(await snap(input, init));
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
        prompt_cache_key: "session-fast-band-off",
      }),
      headers: { "content-type": "application/json" },
    } satisfies RequestInit;

    const first = await run("https://api.openai.com/v1/responses", request);
    expect(first.status).toBe(200);

    Date.now = () => base + 60_001;
    const second = await run("https://api.openai.com/v1/responses", request);
    expect(second.status).toBe(200);
    await Bun.sleep(0);

    hits.length = 0;
    const third = await run("https://api.openai.com/v1/responses", request);
    expect(third.status).toBe(200);
    expect(body(hits[0])).toEqual({
      model: "gpt-5",
      input: "hi",
      prompt_cache_key: "session-fast-band-off",
    });
    expect(toasts).toHaveLength(2);
    expect(toasts[1]?.message).toContain("Fast: disabled (low score");
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
              used_percent: usageHits === 1 ? 79 : 98,
              reset_after_seconds: 900,
              limit_window_seconds: 18_000,
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
        message: fastToast(
          true,
          "Account:\n> [unknown] fast-expire: n/a",
            "only available account",
            "ok",
            [
              "main    rate.primary +1.527",
              "= base   [********] +1.527",
              "= final  [********] +1.527",
            ],
          undefined,
          "fast-expire",
        ),
        variant: "info",
        duration: 10_000,
      },
      {
        title: "Codex Pool",
          message: fastToast(
            true,
            "Account:\n> [plus] fast-expire (5m ago):\n    [5h] 14.557",
            "only available account",
            "ok",
            [
              "main    rate.primary +1.527",
              "= base   [********] +1.527",
              "= final  [********] +1.527",
            ],
          undefined,
          "fast-expire",
        ),
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("shows stale age and blocked tags next to the account name in a fixed order", async () => {
    store.upsert(row("stale-block", 0, { plan_type: "plus" }));

    const staleAt = Date.now() - 120_000;
    store.cacheUsage("stale-block", scored(0), staleAt);

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      if (url(input) === CODEX_USAGE_ENDPOINT) return usage(90, 600);
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client, toasts } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses");

    expect(res.status).toBe(200);
    expect(toasts[0]?.message).toContain(
      "Account:\n> [plus] stale-block (2m ago, blocked): 0.000",
    );
  });

  test("skips priority injection when remaining capacity falls below the floor", async () => {
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
              used_percent: 98,
              reset_after_seconds: 900,
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
    store.cacheUsage("stale-only", scored(0.9));

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
              used_percent: 98,
              reset_after_seconds: 900,
              limit_window_seconds: 18_000,
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

  test("ignores additional rate limits even when an additional window is exhausted", async () => {
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
                  used_percent: 98,
                  reset_after_seconds: 900,
                  limit_window_seconds: 18_000,
                },
              },
            },
          ],
        });
      }

      hits.push(await snap(input, init));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client, toasts } = stub();
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
    const message = toasts[toasts.length - 1]?.message ?? "";
    expect(message).toContain("Fast: enabled (+0.806)");
    expect(message).not.toContain("additional 1 primary");
  });

  test("does not show additional rate limits in the fast-mode guard summary", async () => {
    store.upsert(row("fast-gap", 0));

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
                  used_percent: 81,
                  reset_after_seconds: 3_600,
                  limit_window_seconds: 18_000,
                },
              },
            },
          ],
        });
      }

      hits.push(await snap(input, init));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client, toasts } = stub();
    const run = createFetch(store, async () => auth(), client);
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
    const message = toasts[0]?.message ?? "";
    expect(message).toContain("Fast: enabled (+0.806)");
    expect(message).not.toContain("additional 1 primary");
    expect(message.endsWith("Fast: enabled (+0.806)")).toBe(true);
  });

  test("ignores incomplete additional rate limits when rate_limit is complete", async () => {
    store.upsert(row("fast-incomplete", 0));

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
              used_percent: 90,
              reset_after_seconds: 900,
              limit_window_seconds: 18_000,
            },
          },
          additional_rate_limits: [
            {
              rate_limit: {
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 18_000,
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
    expect(body(hits[0])).toEqual({
      model: "gpt-5",
      input: "hi",
      service_tier: "priority",
    });
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

  test("disables an account when it stays unauthorized after refresh", async () => {
    store.upsert(row("a", 0));
    store.setPrimary("a");

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (url(input) === "https://auth.openai.com/oauth/token") {
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

      return new Response("unauthorized", {
        status: 401,
        statusText: "Unauthorized",
      });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);
    const res = await run("https://api.openai.com/v1/responses");
    const item = store.get("a");

    expect(res.status).toBe(401);
    expect(item?.disabled_at).not.toBeNull();
    expect(item?.last_error).toBe("Unauthorized");
  });

  test("does not disable an account when refresh aborts", async () => {
    store.upsert(row("a", 0, { expires_at: Date.now() - 1_000 }));
    store.setPrimary("a");

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (url(input) === "https://auth.openai.com/oauth/token") {
        throw new DOMException("The operation was aborted.", "AbortError");
      }

      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);

    await expect(run("https://api.openai.com/v1/responses")).rejects.toThrow(
      "The operation was aborted.",
    );
    expect(store.get("a")?.disabled_at).toBeNull();
  });

  test("does not disable an account when refresh aborts after a 401", async () => {
    store.upsert(row("a", 0));
    store.setPrimary("a");

    let seen = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (url(input) === "https://auth.openai.com/oauth/token") {
        throw new DOMException("The operation was aborted.", "AbortError");
      }

      if (url(input) === CODEX_API_ENDPOINT && seen === 0) {
        seen += 1;
        return new Response("unauthorized", {
          status: 401,
          statusText: "Unauthorized",
        });
      }

      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);

    await expect(run("https://api.openai.com/v1/responses")).rejects.toThrow(
      "The operation was aborted.",
    );
    expect(store.get("a")?.disabled_at).toBeNull();
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
    store.cacheUsage("core-fast", scored((100 - 80) / 7_200));
    store.cacheUsage("pool-fast", scored((100 - 20) / 600));

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
    store.cacheUsage("core-soon", scored((100 - 20) / 600));
    store.cacheUsage("pool-later", scored((100 - 80) / 7_200));

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

  test("prefers a healthy plus pool over a slightly ahead pro core when the base scores are tied", async () => {
    store.upsert(row("core-pro-ahead", 0, { primary: 1 }));
    store.setPrimary("core-pro-ahead");
    store.upsert(row("pool-plus-healthy", 1));

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
        if (auth === "Bearer core-pro-ahead-access") {
          return usage({
            plan_type: "pro",
            rate_limit: {
              primary_window: {
                used_percent: 49,
                reset_after_seconds: 12_000,
                limit_window_seconds: 18_000,
              },
            },
          });
        }

        return usage({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 33,
              reset_after_seconds: 2_400,
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
      "Bearer core-pro-ahead-access",
      "Bearer pool-plus-healthy-access",
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

    const hits: string[] = [];
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
              used_percent: 0,
              reset_after_seconds: 18_000_000,
              limit_window_seconds: 18_000_000,
            },
          },
        });
      }

      const auth = new Headers(init?.headers).get("authorization");
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
      "Bearer core-started-access",
      "Bearer core-started-access",
    ]);
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

  test("lets the longest rate window drive ranking even when the short window is healthy", async () => {
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

  test("ignores additional rate limits when ranking accounts", async () => {
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
      "Bearer core-additional-access",
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
    store.cacheUsage("core-stale", scored(0.5), staleAt);
    store.cacheUsage("pool-stale", scored(0.8), staleAt);

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

  test("revalidates active accounts in the background after the polling window", async () => {
    store.upsert(row("poll-active", 0));

    const base = Date.now();
    store.cacheUsage("poll-active", scored(0.5), base);

    let scans = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (url(input) === CODEX_USAGE_ENDPOINT) {
        scans += 1;
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer poll-active-access",
        );
        return usage(20, 600);
      }

      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { client } = stub();
    const run = createFetch(store, async () => auth(), client);

    Date.now = () => base;
    const first = await run("https://api.openai.com/v1/responses");
    expect(first.status).toBe(200);
    expect(scans).toBe(0);

    Date.now = () => base + 120_000;
    await flushUsagePollers();
    expect(scans).toBe(0);

    Date.now = () => base + 180_001;
    await flushUsagePollers();
    expect(scans).toBe(1);
  });

  test("deduplicates background usage polling across fetch instances", async () => {
    const path = join(tmpdir(), `codex-pool-${crypto.randomUUID()}.sqlite`);
    const left = open(path);
    const right = open(path);
    const base = Date.now();

    try {
      left.upsert(row("shared-poll", 0));
      left.cacheUsage("shared-poll", scored(0.5), base);

      let active = 0;
      let scans = 0;
      let peak = 0;
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        if (url(input) === CODEX_USAGE_ENDPOINT) {
          scans += 1;
          active += 1;
          peak = Math.max(peak, active);
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer shared-poll-access",
          );
          await Bun.sleep(25);
          active -= 1;
          return usage(20, 600);
        }

        return new Response("ok", { status: 200 });
      }) as typeof fetch;

      const { client: leftClient } = stub();
      const { client: rightClient } = stub();
      const leftRun = createFetch(left, async () => auth(), leftClient);
      const rightRun = createFetch(right, async () => auth(), rightClient);

      Date.now = () => base;
      const first = await leftRun("https://api.openai.com/v1/responses");
      const second = await rightRun("https://api.openai.com/v1/responses");

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(scans).toBe(0);

      Date.now = () => base + 180_001;
      await flushUsagePollers();

      expect(scans).toBe(1);
      expect(peak).toBe(1);
    } finally {
      left.close();
      right.close();
      rmSync(path, { force: true });
    }
  });

  test("store.close disposes the shared usage poller", async () => {
    const local = open(":memory:");

    try {
      local.upsert(row("poll-close", 0));
      local.cacheUsage("poll-close", scored(0.5), Date.now());

      let scans = 0;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        if (url(input) === CODEX_USAGE_ENDPOINT) scans += 1;
        return new Response("ok", { status: 200 });
      }) as typeof fetch;

      const { client } = stub();
      const run = createFetch(local, async () => auth(), client);
      const res = await run("https://api.openai.com/v1/responses");

      expect(res.status).toBe(200);
      local.close();
      await flushUsagePollers();
      expect(scans).toBe(0);
    } finally {
      resetUsagePollers();
      try {
        local.close();
      } catch {}
    }
  });

  test("refresh clears a stale quota cache and falls back to core until usage is rewarmed", async () => {
    store.upsert(row("core-refresh", 0, { primary: 1 }));
    store.setPrimary("core-refresh");
    store.upsert(row("pool-refresh", 1));
    store.cacheUsage("core-refresh", scored(1));
    store.cacheUsage("pool-refresh", scored(0.1));

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
    expect(store.usage("core-refresh", 60_000)).toBeUndefined();

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

    store.cacheUsage("core-sticky", scored(0.5));
    store.cacheUsage("pool-sticky", scored(0.55));

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
    store.cacheUsage("core-sticky", scored(0.56));
    store.cacheUsage("pool-sticky", scored(0.55));

    await run("https://api.openai.com/v1/responses", { body });

    // core 0.56 does NOT exceed pool 0.55 * 1.2 = 0.66, so affinity holds
    expect(hits).toEqual([
      "Bearer pool-sticky-access",
      "Bearer pool-sticky-access",
    ]);
    expect(toasts).toHaveLength(1);
  });

  test("sticky affinity can keep a lower-priority pool account", async () => {
    store.upsert(row("core-multi-sticky", 0, { primary: 1 }));
    store.setPrimary("core-multi-sticky");
    store.upsert(row("pool-first-multi-sticky", 1));
    store.upsert(row("pool-second-multi-sticky", 2));

    store.cacheUsage("core-multi-sticky", scored(0.5));
    store.cacheUsage("pool-first-multi-sticky", scored(0.6));
    store.cacheUsage("pool-second-multi-sticky", scored(0.8));

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
    const body = JSON.stringify({ prompt_cache_key: "ses-multi-sticky" });

    await run("https://api.openai.com/v1/responses", { body });

    store.cacheUsage("core-multi-sticky", scored(0.7));
    store.cacheUsage("pool-first-multi-sticky", scored(0.81));
    store.cacheUsage("pool-second-multi-sticky", scored(0.8));

    await run("https://api.openai.com/v1/responses", { body });

    expect(hits).toEqual([
      "Bearer pool-second-multi-sticky-access",
      "Bearer pool-second-multi-sticky-access",
    ]);
  });

  test("re-ranks remaining pool accounts by score when core is unavailable", async () => {
    store.upsert(row("core-pool-only", 0, { primary: 1 }));
    store.setPrimary("core-pool-only");
    store.upsert(row("pool-first-only", 1));
    store.upsert(row("pool-second-only", 2));
    store.cacheUsage("core-pool-only", scored(0.9));
    store.cacheUsage("pool-first-only", scored(0.4));
    store.cacheUsage("pool-second-only", scored(0.8));
    store.setCooldown("core-pool-only", Date.now() + 60_000, 429, "rate_limited", 60_000);

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
    const res = await run("https://api.openai.com/v1/responses");

    expect(res.status).toBe(200);
    expect(hits).toEqual(["Bearer pool-second-only-access"]);
    expect(toasts).toEqual([
      {
        title: "Codex Pool",
        message: fastToast(
          false,
          "Accounts:\n  [unknown] pool-first-only:\n    [4.8m] 0.400\n> [unknown] pool-second-only:\n    [19.2m] 0.800",
          "higher score",
          "no data",
          [],
          "request body",
          "pool-second-only",
        ),
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("sticky affinity yields when alternative score exceeds margin", async () => {
    store.upsert(row("core-yield", 0, { primary: 1 }));
    store.setPrimary("core-yield");
    store.upsert(row("pool-yield", 1));

    store.cacheUsage("core-yield", scored(0.5));
    store.cacheUsage("pool-yield", scored(0.55));

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
    store.cacheUsage("core-yield", scored(0.8));
    store.cacheUsage("pool-yield", scored(0.55));

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

    store.cacheUsage("core-block", scored(0.5));
    store.cacheUsage("pool-block", scored(0.3));

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
    store.cacheUsage("core-block", scored(0));
    store.cacheUsage("pool-block", scored(0.3));

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

    store.cacheUsage("core-ind", scored(0.5));
    store.cacheUsage("pool-ind", scored(0.55));

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
    store.cacheUsage("core-ind", scored(0.56));
    store.cacheUsage("pool-ind", scored(0.55));

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

    store.cacheUsage("core-am", scored(0.1));
    store.cacheUsage("pool-am", scored(0.12));

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
    store.cacheUsage("core-am", scored(0.12));
    store.cacheUsage("pool-am", scored(0.1));

    await run("https://api.openai.com/v1/responses", { body });

    expect(hits).toEqual([
      "Bearer pool-am-access",
      "Bearer core-am-access",
    ]);
  });
});
