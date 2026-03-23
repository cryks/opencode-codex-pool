export interface Account {
  id: string;
  subject: string | null;
  email: string | null;
  chatgpt_account_id: string | null;
  label: string | null;
  plan_type: string | null;
  priority: number;
  primary: number;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  disabled_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface Cooldown {
  account_id: string;
  until_at: number;
  retry_after_ms: number | null;
  status: number;
  reason: string;
  created_at: number;
  updated_at: number;
}

export interface Lock {
  key: string;
  owner: string;
  until_at: number;
  updated_at: number;
}

export interface Window {
  used_percent?: number;
  reset_after_seconds?: number;
  limit_window_seconds?: number;
}

export interface Limit {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: Window;
  secondary_window?: Window;
}

export interface AdditionalLimit {
  rate_limit?: Limit;
  name?: string;
  label?: string;
  slug?: string;
  type?: string;
  plan_type?: string;
  resource?: string;
}

export interface Usage {
  account_id?: string;
  plan_type?: string;
  rate_limit?: Limit;
  additional_rate_limits?: AdditionalLimit[];
  code_review_rate_limit?: Limit;
}

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  id_token?: string;
}

export interface AccountMeta {
  subject?: string;
  email?: string;
  chatgpt_account_id?: string;
}

export const SENTINEL_SHADOW_PROVIDER = "openai-codex-pool-shadow";
export const OAUTH_DUMMY_KEY = "OAUTH_DUMMY_KEY";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_API_ENDPOINT =
  "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_OAUTH_PORT = 1455;

export const DEFAULT_COOLDOWN_MS = 60_000;
export const REFRESH_LEASE_MS = 30_000;
export const CONSERVATION_REF = 14_400;
export const CONSERVATION_HORIZON = 1_209_600;
export const CAPACITY_REF = 1_800;
