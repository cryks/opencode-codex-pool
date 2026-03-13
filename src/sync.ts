import type { Auth } from "@opencode-ai/sdk";

import { extractAccountId, extractAccountMeta } from "./codex";
import type { Store } from "./store";
import type { Account, TokenSet } from "./types";

export async function bootstrap(store: Store, getAuth: () => Promise<Auth>) {
  const auth = await getAuth();
  if (auth.type !== "oauth") return;

  const tokens: TokenSet = {
    access_token: auth.access,
    refresh_token: auth.refresh,
  };
  const meta = extractAccountMeta(tokens);
  const id =
    extractAccountId(tokens) ||
    (auth as typeof auth & { accountId?: string }).accountId ||
    crypto.randomUUID();
  const row = store.get(id);
  const now = Date.now();
  const account: Account = {
    id,
    subject: meta.subject ?? row?.subject ?? null,
    email: meta.email ?? row?.email ?? null,
    chatgpt_account_id:
      meta.chatgpt_account_id ?? row?.chatgpt_account_id ?? null,
    label: row?.label ?? meta.email ?? null,
    priority: 0,
    primary: 1,
    access_token: auth.access,
    refresh_token: auth.refresh,
    expires_at: auth.expires,
    disabled_at: null,
    last_error: null,
    created_at: row?.created_at ?? now,
    updated_at: now,
  };

  store.upsert(account);
  store.setPrimary(id);
}
