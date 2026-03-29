import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, readConfig, renderConfig } from "../src/config";

describe("config", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const path of paths.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("creates the default config when missing", async () => {
    const dir = join(tmpdir(), `codex-pool-${crypto.randomUUID()}`);
    const path = join(dir, "codex-pool.json");
    paths.push(dir);

    const state = await readConfig(path);

    expect(state.config).toEqual(DEFAULT_CONFIG);
    expect(state.warning).toBeUndefined();
    expect(await Bun.file(path).text()).toBe(renderConfig());
  });

  test("reads the configured fast-mode", async () => {
    const dir = join(tmpdir(), `codex-pool-${crypto.randomUUID()}`);
    const path = join(dir, "codex-pool.json");
    paths.push(dir);

    mkdirSync(dir, { recursive: true });
    await Bun.write(path, JSON.stringify({ "fast-mode": "always" }));
    expect((await readConfig(path)).config.fastMode).toBe("always");

    await Bun.write(path, JSON.stringify({ "fast-mode": "disabled" }));
    expect((await readConfig(path)).config.fastMode).toBe("disabled");
  });

  test("reads sticky and dormant-touch config values", async () => {
    const dir = join(tmpdir(), `codex-pool-${crypto.randomUUID()}`);
    const path = join(dir, "codex-pool.json");
    paths.push(dir);

    mkdirSync(dir, { recursive: true });
    await Bun.write(
      path,
      JSON.stringify({
        "sticky-mode": "always",
        "sticky-strength": 2.5,
        "dormant-touch": false,
      }),
    );

    expect((await readConfig(path)).config).toEqual({
      ...DEFAULT_CONFIG,
      stickyMode: "always",
      stickyStrength: 2.5,
      dormantTouch: false,
    });
  });

  test("falls back to defaults when fast-mode is invalid", async () => {
    const dir = join(tmpdir(), `codex-pool-${crypto.randomUUID()}`);
    const path = join(dir, "codex-pool.json");
    paths.push(dir);

    mkdirSync(dir, { recursive: true });
    await Bun.write(path, JSON.stringify({ "fast-mode": "nope" }));
    const state = await readConfig(path);

    expect(state.config).toEqual(DEFAULT_CONFIG);
    expect(state.warning).toContain("Invalid config");
    expect(state.warning).toContain('"fast-mode"');
  });

  test("falls back to defaults when sticky-mode is invalid", async () => {
    const dir = join(tmpdir(), `codex-pool-${crypto.randomUUID()}`);
    const path = join(dir, "codex-pool.json");
    paths.push(dir);

    mkdirSync(dir, { recursive: true });
    await Bun.write(path, JSON.stringify({ "sticky-mode": "nope" }));
    const state = await readConfig(path);

    expect(state.config).toEqual(DEFAULT_CONFIG);
    expect(state.warning).toContain('"sticky-mode"');
  });

  test("falls back to defaults when sticky-strength is invalid", async () => {
    const dir = join(tmpdir(), `codex-pool-${crypto.randomUUID()}`);
    const path = join(dir, "codex-pool.json");
    paths.push(dir);

    mkdirSync(dir, { recursive: true });
    await Bun.write(path, JSON.stringify({ "sticky-strength": -1 }));
    const state = await readConfig(path);

    expect(state.config).toEqual(DEFAULT_CONFIG);
    expect(state.warning).toContain('"sticky-strength"');
  });

  test("falls back to defaults when dormant-touch is invalid", async () => {
    const dir = join(tmpdir(), `codex-pool-${crypto.randomUUID()}`);
    const path = join(dir, "codex-pool.json");
    paths.push(dir);

    mkdirSync(dir, { recursive: true });
    await Bun.write(path, JSON.stringify({ "dormant-touch": "nope" }));
    const state = await readConfig(path);

    expect(state.config).toEqual(DEFAULT_CONFIG);
    expect(state.warning).toContain('"dormant-touch"');
  });
});
