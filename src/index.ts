import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import { extractAccountId, extractAccountMeta } from "./codex";
import { createFetch } from "./fetch";
import { browserFlow, headlessFlow } from "./oauth";
import { bootstrap } from "./sync";
import { open } from "./store";
import type { Store } from "./store";
import type { Account, TokenSet } from "./types";
import { OAUTH_DUMMY_KEY, SENTINEL_SHADOW_PROVIDER } from "./types";

let db: Store | undefined;

function use() {
  if (!db) db = open();
  return db;
}

function save(tokens: TokenSet, priority: number, primary: boolean) {
  const store = use();
  const id = extractAccountId(tokens) || crypto.randomUUID();
  const meta = extractAccountMeta(tokens);
  const row = store.get(id);
  const now = Date.now();
  const account: Account = {
    id,
    subject: meta.subject ?? row?.subject ?? null,
    email: meta.email ?? row?.email ?? null,
    chatgpt_account_id:
      meta.chatgpt_account_id ?? row?.chatgpt_account_id ?? null,
    label: row?.label ?? meta.email ?? null,
    priority,
    primary: primary ? 1 : 0,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: now + (tokens.expires_in ?? 3600) * 1000,
    disabled_at: null,
    last_error: null,
    created_at: row?.created_at ?? now,
    updated_at: now,
  };

  store.upsert(account);
  if (primary) store.setPrimary(id);
  return store.get(id) ?? account;
}

function browser(label: string, primary: boolean) {
  return {
    label,
    type: "oauth" as const,
    authorize: async () => {
      const flow = browserFlow();
      const auth = await flow.authorize();

      return {
        url: auth.url,
        instructions:
          "Complete authorization in your browser. This window will close automatically.",
        method: "auto" as const,
        callback: async () => {
          try {
            const tokens = await flow.waitForCallback(auth.pkce, auth.state);
            const priority = primary ? 0 : use().nextPriority();
            const account = save(tokens, priority, primary);

            if (primary) {
              return {
                type: "success" as const,
                provider: "openai",
                refresh: tokens.refresh_token,
                access: tokens.access_token,
                expires: account.expires_at,
                accountId: account.id,
              };
            }

            return {
              type: "success" as const,
              provider: SENTINEL_SHADOW_PROVIDER,
              key: "shadow",
            };
          } finally {
            flow.stop();
          }
        },
      };
    },
  };
}

function device(label: string, primary: boolean) {
  return {
    label,
    type: "oauth" as const,
    authorize: async () => {
      const flow = await headlessFlow();

      return {
        url: flow.url,
        instructions: `Enter code: ${flow.userCode}`,
        method: "auto" as const,
        callback: async () => {
          const tokens = await flow.poll();
          const priority = primary ? 0 : use().nextPriority();
          const account = save(tokens, priority, primary);

          if (primary) {
            return {
              type: "success" as const,
              provider: "openai",
              refresh: tokens.refresh_token,
              access: tokens.access_token,
              expires: account.expires_at,
              accountId: account.id,
            };
          }

          return {
            type: "success" as const,
            provider: SENTINEL_SHADOW_PROVIDER,
            key: "shadow",
          };
        },
      };
    },
  };
}

export default async function (input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "openai",
      loader: async (getAuth) => {
        const auth = await getAuth();
        if (auth.type !== "oauth") return {};

        let store: Store;

        try {
          store = use();
        } catch {
          return {};
        }

        if (store.count() === 0) {
          await bootstrap(store, getAuth);
        }

        if (store.count() === 0) return {};

        return {
          apiKey: OAUTH_DUMMY_KEY,
          fetch: createFetch(store, getAuth, input.client),
        };
      },
      methods: [
        browser("Login primary Codex account (browser)", true),
        device("Login primary Codex account (headless)", true),
        browser("Add Codex account (browser)", false),
        device("Add Codex account (headless)", false),
      ],
    },
  };
}
