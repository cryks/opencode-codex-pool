import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type FastMode = "auto" | "always" | "disabled";
export type StickyMode = "auto" | "always" | "disabled";

export interface PoolConfig {
  fastMode: FastMode;
  stickyMode: StickyMode;
  stickyStrength: number;
  dormantTouch: boolean;
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
  stickyMode: "auto",
  stickyStrength: 1,
  dormantTouch: true,
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
  if (mode !== undefined) {
    if (mode !== "auto" && mode !== "always" && mode !== "disabled") {
      throw new Error('"fast-mode" must be "auto", "always", or "disabled"');
    }
  }

  const stickyMode = value["sticky-mode"];
  if (stickyMode !== undefined) {
    if (
      stickyMode !== "auto" &&
      stickyMode !== "always" &&
      stickyMode !== "disabled"
    ) {
      throw new Error('"sticky-mode" must be "auto", "always", or "disabled"');
    }
  }

  const stickyStrength = value["sticky-strength"];
  if (stickyStrength !== undefined) {
    if (
      typeof stickyStrength !== "number" ||
      !Number.isFinite(stickyStrength) ||
      stickyStrength < 0
    ) {
      throw new Error('"sticky-strength" must be a finite number >= 0');
    }
  }

  const dormantTouch = value["dormant-touch"];
  if (dormantTouch !== undefined) {
    if (typeof dormantTouch !== "boolean") {
      throw new Error('"dormant-touch" must be a boolean');
    }
  }

  return {
    fastMode: mode ?? DEFAULT_CONFIG.fastMode,
    stickyMode: stickyMode ?? DEFAULT_CONFIG.stickyMode,
    stickyStrength: stickyStrength ?? DEFAULT_CONFIG.stickyStrength,
    dormantTouch: dormantTouch ?? DEFAULT_CONFIG.dormantTouch,
  };
}

export function renderConfig(config: PoolConfig = DEFAULT_CONFIG) {
  return `${JSON.stringify(
    {
      "fast-mode": config.fastMode,
      "sticky-mode": config.stickyMode,
      "sticky-strength": config.stickyStrength,
      "dormant-touch": config.dormantTouch,
    },
    null,
    2,
  )}\n`;
}

export async function readConfig(path = DEFAULT_CONFIG_PATH): Promise<ConfigState> {
  try {
    const file = Bun.file(path);

    if (!(await file.exists())) {
      mkdirSync(dirname(path), { recursive: true });
      await Bun.write(path, renderConfig());
      return {
        path,
        config: { ...DEFAULT_CONFIG },
      } satisfies ConfigState;
    }

    return {
      path,
      config: parse(await file.json()),
    } satisfies ConfigState;
  } catch (err) {
    return {
      path,
      config: { ...DEFAULT_CONFIG },
      warning: `Invalid config at ${path}; using defaults (${message(err)})`,
    } satisfies ConfigState;
  }
}
