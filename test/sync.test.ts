import type { Auth } from "@opencode-ai/sdk";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { bootstrap } from "../src/sync";
import { open } from "../src/store";
import type { Store } from "../src/store";

function jwt(claims: Record<string, unknown>) {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.`;
}

function auth(sub: string, email: string, org: string): Auth {
  return {
    type: "oauth",
    access: jwt({
      sub,
      email,
      chatgpt_account_id: org,
      organizations: [{ id: org }],
    }),
    refresh: `${sub}-refresh`,
    expires: Date.now() + 3_600_000,
  };
}

describe("bootstrap", () => {
  let store: Store;

  beforeEach(() => {
    store = open(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("keeps separate accounts from the same ChatGPT organization", async () => {
    await bootstrap(store, async () => auth("user-1", "one@example.com", "org-1"));
    await bootstrap(store, async () => auth("user-2", "two@example.com", "org-1"));

    expect(store.list().map((item) => item.id).sort()).toEqual([
      "user-1",
      "user-2",
    ]);
    expect(store.get("user-1")?.chatgpt_account_id).toBe("org-1");
    expect(store.get("user-2")?.chatgpt_account_id).toBe("org-1");
  });
});
