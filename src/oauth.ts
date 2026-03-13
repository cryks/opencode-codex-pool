import { setTimeout as sleep } from "node:timers/promises";
import type { Pkce } from "./codex";
import {
  HTML_ERROR,
  HTML_SUCCESS,
  buildAuthorizeUrl,
  exchangeCode,
  generatePKCE,
  generateState,
  refreshToken as renew,
} from "./codex";
import type { TokenSet } from "./types";
import { CODEX_CLIENT_ID, CODEX_ISSUER, CODEX_OAUTH_PORT } from "./types";

const AGENT = "codex-pool/0.1.0";
const MARGIN = 3000;
const TIMEOUT = 5 * 60 * 1000;

interface Pending {
  pkce: Pkce;
  state: string;
  resolve: (tokens: TokenSet) => void;
  reject: (error: Error) => void;
}

interface DeviceStart {
  device_auth_id: string;
  user_code: string;
  interval: string;
  expires_in?: string | number;
}

interface DeviceToken {
  authorization_code: string;
  code_verifier: string;
}

export function browserFlow(port = CODEX_OAUTH_PORT) {
  let pending: Pending | undefined;
  let live = true;
  const redirect = `http://localhost:${port}/auth/callback`;
  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/auth/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        const detail = url.searchParams.get("error_description");

        if (error) {
          const msg = detail || error;
          pending?.reject(new Error(msg));
          pending = undefined;
          return new Response(HTML_ERROR(msg), {
            headers: { "Content-Type": "text/html" },
          });
        }

        if (!code) {
          const msg = "Missing authorization code";
          pending?.reject(new Error(msg));
          pending = undefined;
          return new Response(HTML_ERROR(msg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          });
        }

        if (!pending || state !== pending.state) {
          const msg = "Invalid state - potential CSRF attack";
          pending?.reject(new Error(msg));
          pending = undefined;
          return new Response(HTML_ERROR(msg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          });
        }

        const current = pending;
        pending = undefined;

        exchangeCode(code, redirect, current.pkce)
          .then((tokens) => current.resolve(tokens))
          .catch((err) =>
            current.reject(err instanceof Error ? err : new Error(String(err))),
          );

        return new Response(HTML_SUCCESS, {
          headers: { "Content-Type": "text/html" },
        });
      }

      if (url.pathname === "/cancel") {
        pending?.reject(new Error("Login cancelled"));
        pending = undefined;
        return new Response("Login cancelled", { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return {
    async authorize() {
      const pkce = await generatePKCE();
      const state = generateState();
      const url = buildAuthorizeUrl(redirect, pkce, state);
      return { url, pkce, state };
    },
    waitForCallback(pkce: Pkce, state: string): Promise<TokenSet> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!pending) return;
          pending = undefined;
          reject(
            new Error("OAuth callback timeout - authorization took too long"),
          );
        }, TIMEOUT);

        pending = {
          pkce,
          state,
          resolve: (tokens) => {
            clearTimeout(timeout);
            resolve(tokens);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        };
      });
    },
    stop() {
      if (pending) {
        pending.reject(new Error("Login cancelled"));
        pending = undefined;
      }
      if (!live) return;
      live = false;
      server.stop();
    },
  };
}

export async function headlessFlow() {
  const response = await fetch(
    `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": AGENT,
      },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    },
  );

  if (!response.ok) {
    throw new Error("Failed to initiate device authorization");
  }

  const data = (await response.json()) as DeviceStart;
  const interval = Math.max(parseInt(String(data.interval)) || 5, 1) * 1000;
  const ttl =
    Math.max(parseInt(String(data.expires_in ?? 900)) || 900, 1) * 1000;

  return {
    url: `${CODEX_ISSUER}/codex/device`,
    userCode: data.user_code,
    async poll(): Promise<TokenSet> {
      const end = Date.now() + ttl;
      while (Date.now() < end) {
        const poll = await fetch(
          `${CODEX_ISSUER}/api/accounts/deviceauth/token`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": AGENT,
            },
            body: JSON.stringify({
              device_auth_id: data.device_auth_id,
              user_code: data.user_code,
            }),
          },
        );

        if (poll.ok) {
          const code = (await poll.json()) as DeviceToken;
          const token = await fetch(`${CODEX_ISSUER}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: code.authorization_code,
              redirect_uri: `${CODEX_ISSUER}/deviceauth/callback`,
              client_id: CODEX_CLIENT_ID,
              code_verifier: code.code_verifier,
            }).toString(),
          });

          if (!token.ok) {
            throw new Error(`Token exchange failed: ${token.status}`);
          }

          return (await token.json()) as TokenSet;
        }

        if (poll.status !== 403 && poll.status !== 404) {
          throw new Error(`Device authorization failed: ${poll.status}`);
        }

        await sleep(interval + MARGIN);
      }

      throw new Error("Device authorization timeout");
    },
  };
}

export function refresh(refreshToken: string): Promise<TokenSet> {
  return renew(refreshToken);
}
