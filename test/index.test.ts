import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { edit } from "../src/index";
import { open } from "../src/store";
import type { Store } from "../src/store";
import type { Account } from "../src/types";

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

function stub() {
  const toasts: {
    title: string;
    message: string;
    variant: string;
    duration: number;
  }[] = [];

  return {
    client: {
      tui: {
        showToast({ body }: { body: (typeof toasts)[number] }) {
          toasts.push(body);
          return Promise.resolve(undefined);
        },
      },
    },
    toasts,
  };
}

describe("edit pool accounts auth method", () => {
  let store: Store;

  beforeEach(() => {
    store = open(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("lists only pool accounts in the select prompt", () => {
    store.upsert(row("primary", 0, { primary: 1, label: "primary" }));
    store.setPrimary("primary");
    store.upsert(row("pool-a", 1, { label: "Pool A", plan_type: "plus" }));
    store.upsert(row("pool-b", 2, { label: "Pool B", plan_type: "pro" }));

    const { client } = stub();
    const method = edit(client, store);
    const prompt = method.prompts?.[0];

    expect(prompt?.type).toBe("select");
    if (!prompt || prompt.type !== "select") throw new Error("missing select prompt");
    expect(prompt.options).toEqual([
      { label: "[plus] Pool A", value: "pool-a", hint: "pool-a@example.com" },
      { label: "[pro] Pool B", value: "pool-b", hint: "pool-b@example.com" },
    ]);
  });

  test("deletes the selected pool account after confirmation", async () => {
    store.upsert(row("primary", 0, { primary: 1, label: "primary" }));
    store.setPrimary("primary");
    store.upsert(row("pool-a", 1, { label: "Pool A", plan_type: "plus" }));

    const { client, toasts } = stub();
    const method = edit(client, store);
    const res = await method.authorize?.({ account: "pool-a", confirm: "delete" });

    expect(res).toEqual({
      type: "success",
      provider: "openai-codex-pool-shadow",
      key: "shadow",
    });
    expect(store.get("pool-a")).toBeNull();
    expect(toasts).toEqual([
      {
        title: "Codex Pool",
        message: "Deleted pool account: [plus] Pool A",
        variant: "info",
        duration: 10_000,
      },
    ]);
  });

  test("shows an empty-state option when no pool accounts exist", async () => {
    store.upsert(row("primary", 0, { primary: 1, label: "primary" }));
    store.setPrimary("primary");

    const { client, toasts } = stub();
    const method = edit(client, store);
    const prompt = method.prompts?.[0];

    expect(prompt?.type).toBe("select");
    if (!prompt || prompt.type !== "select") throw new Error("missing select prompt");
    expect(prompt.options).toEqual([
      {
        label: "No pool accounts",
        value: "__none__",
        hint: "Add a pool account first",
      },
    ]);

    const res = await method.authorize?.({ account: "__none__" });
    expect(res).toEqual({
      type: "success",
      provider: "openai-codex-pool-shadow",
      key: "shadow",
    });
    expect(toasts).toEqual([
      {
        title: "Codex Pool",
        message: "No pool accounts to edit",
        variant: "info",
        duration: 10_000,
      },
    ]);
  });
});
