import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type FastMode = "auto" | "always" | "disabled";

export interface PoolConfig {
  fastMode: FastMode;
}

export interface ConfigState {
  path: string;
  config: PoolConfig;
  warning?: string;
}

export const DEFAULT_CONFIG_PATH = join(
  homedir(),
  ".config",
  "opencode",
  "codex-pool.json",
);

export const DEFAULT_CONFIG: PoolConfig = {
  fastMode: "auto",
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function parse(value: unknown): PoolConfig {
  if (!object(value)) throw new Error("Config must be a JSON object");

  const mode = value["fast-mode"];
  if (mode === undefined) {
    return { fastMode: DEFAULT_CONFIG.fastMode };
  }

  if (mode === "auto" || mode === "always" || mode === "disabled") {
    return { fastMode: mode };
  }

  throw new Error('"fast-mode" must be "auto", "always", or "disabled"');
}

export function renderConfig(config: PoolConfig = DEFAULT_CONFIG) {
  return `${JSON.stringify({ "fast-mode": config.fastMode }, null, 2)}\n`;
}

export async function readConfig(path = DEFAULT_CONFIG_PATH): Promise<ConfigState> {
  try {
    const file = Bun.file(path);

    if (!(await file.exists())) {
      mkdirSync(dirname(path), { recursive: true });
      await Bun.write(path, renderConfig());
      return {
        path,
        config: { fastMode: DEFAULT_CONFIG.fastMode },
      } satisfies ConfigState;
    }

    return {
      path,
      config: parse(await file.json()),
    } satisfies ConfigState;
  } catch (err) {
    return {
      path,
      config: { fastMode: DEFAULT_CONFIG.fastMode },
      warning: `Invalid config at ${path}; using defaults (${message(err)})`,
    } satisfies ConfigState;
  }
}
