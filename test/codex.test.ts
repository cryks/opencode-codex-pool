import { describe, expect, test } from "bun:test";

import { extractAccountId, extractAccountMeta } from "../src/codex";
import type { TokenSet } from "../src/types";

function jwt(claims: Record<string, unknown>) {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.`;
}

describe("codex token metadata", () => {
  test("prefers subject for the stored account id", () => {
    const tokens: TokenSet = {
      access_token: jwt({
        sub: "user-1",
        email: "user@example.com",
        chatgpt_account_id: "org-1",
        organizations: [{ id: "org-1" }],
      }),
      refresh_token: "refresh",
    };

    expect(extractAccountId(tokens)).toBe("user-1");
    expect(extractAccountMeta(tokens)).toEqual({
      subject: "user-1",
      email: "user@example.com",
      chatgpt_account_id: "org-1",
    });
  });

  test("falls back to the ChatGPT account id when subject is missing", () => {
    const tokens: TokenSet = {
      access_token: jwt({
        chatgpt_account_id: "org-1",
        organizations: [{ id: "org-1" }],
      }),
      refresh_token: "refresh",
    };

    expect(extractAccountId(tokens)).toBe("org-1");
  });
});
