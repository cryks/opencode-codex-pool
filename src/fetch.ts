import type { Auth } from "@opencode-ai/sdk";
import type { PluginInput } from "@opencode-ai/plugin";

import { refresh } from "./oauth";
import type { Store } from "./store";
import {
  CODEX_API_ENDPOINT,
  CODEX_USAGE_ENDPOINT,
  REFRESH_LEASE_MS,
  CONSERVATION_REF,
  CONSERVATION_HORIZON,
  CAPACITY_REF,
  type AdditionalLimit,
  type Limit,
  type Usage,
  type Window,
} from "./types";

type Client = PluginInput["client"];
type Row = NonNullable<ReturnType<Store["primary"]>>;
type UsageHit = NonNullable<ReturnType<Store["usageInfo"]>>;
const QUOTA_CACHE_MS = 1 * 60 * 1000;
const STALE_QUOTA_MS = 60 * 60 * 1000;
const USAGE_POLL_MS = 30 * 1000;
const USAGE_REVALIDATE_MS = 3 * 60 * 1000;
const USAGE_FETCH_LEASE_MS = 25 * 1000;
const USAGE_FETCH_WAIT_MS = 5 * 1000;
const USAGE_ACTIVE_MS = 5 * 60 * 1000;
const SWITCH_MARGIN = 0.2;
const AFFINITY_MS = 300_000;
const CONSERVATION_CAP = 1 + Math.log(CONSERVATION_HORIZON / CONSERVATION_REF);
const DORMANT_SLACK = 60;
const PRO_PLAN_WEIGHT = Math.sqrt(6.7);

interface Affinity {
  id?: string;
  at: number;
  fast?: boolean;
}

interface AttemptResult {
  init: RequestInit | undefined;
  fast: boolean;
  note: string;
}

function active(affinity: Affinity) {
  return Boolean(affinity.id) && Date.now() - affinity.at < AFFINITY_MS;
}

type ScoreSource = "fresh" | "stale" | "missing";
type UsageSource = "fresh" | "stale" | "missing";

interface UsageView {
  body?: Usage;
  source: UsageSource;
  at?: number;
}

interface ScoreView {
  id: string;
  name: string;
  plan: string;
  role: "core" | "pool";
  score?: number;
  source: ScoreSource;
  deciding?: string;
  windows: ScoreWindow[];
  main?: ScoreWindow;
  guard?: ScoreGuard;
  age?: string;
}

interface ScoreWindow {
  label: string;
  name: string;
  score: number;
}

interface ScoreGuard {
  label: string;
  name: string;
  factor: number;
  score: number;
}

interface RankResult {
  rows: Row[];
  scores: ScoreView[];
  reason?: string;
}

function order(rows: Row[], scores: Map<string, number>) {
  return [...rows].sort((a, b) => {
    const left = scores.get(a.id) ?? 0;
    const right = scores.get(b.id) ?? 0;
    if (left !== right) return right - left;
    return a.priority - b.priority;
  });
}

function place(rows: Row[], id: string) {
  const item = rows.find((row) => row.id === id);
  if (!item) return rows;
  return [item, ...rows.filter((row) => row.id !== id)];
}

const decoder = new TextDecoder();
const FAST_MIN_LEFT = 0.03;
const FAST_SCORE_ON = 0.05;
const FAST_SCORE_OFF = -0.02;
const HEALTH_RANGE = 0.2;
const HEALTH_BONUS = 0.12;
const HEALTH_PENALTY = 0.18;

function cacheKey(body: ArrayBuffer | null): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(decoder.decode(body));
    const key = parsed.prompt_cache_key;
    return typeof key === "string" ? key : undefined;
  } catch {
    return undefined;
  }
}

interface ReadyWindow {
  used_percent: number;
  reset_after_seconds: number;
  limit_window_seconds: number;
}

interface ScoreHit {
  score: number | null;
  label?: string;
  windows: ScoreWindow[];
  main?: ScoreWindow;
  guard?: ScoreGuard;
}

interface RankWindow extends ScoreWindow {
  ready?: ReadyWindow;
  span?: number;
}

type FastWindowState = "scored" | "floor" | "blocked" | "incomplete";

interface FastWindowView {
  label: string;
  target: string;
  state: FastWindowState;
  score?: number;
  raw?: number;
  base?: number;
  left?: number;
  span?: number;
  dormant?: boolean;
}

interface FastView {
  fast: boolean;
  rule: string;
  target?: string;
  score?: number;
  detail?: FastWindowView;
  windows: FastWindowView[];
  main?: FastWindowView;
  guards?: FastWindowView[];
  cost?: number;
}

interface FastProfile {
  main: FastWindowView;
  guard?: FastWindowView;
  score: number;
  cost: number;
  guards: FastWindowView[];
}

interface JsonBody {
  body: Record<string, unknown>;
  tier: boolean;
}

interface UsagePoller {
  touch(rows: Row[]): void;
  flush(): Promise<void>;
  stop(): void;
}

const scheduleTimeout = globalThis.setTimeout.bind(globalThis);
const cancelTimeout = globalThis.clearTimeout.bind(globalThis);
const loadingUsage = new Map<string, Promise<Usage | null>>();
const usagePollers = new Map<Store, UsagePoller>();
const usageClose = new WeakSet<Store>();

export async function flushUsagePollers() {
  await Promise.all([...usagePollers.values()].map((item) => item.flush()));
}

export function resetUsagePollers() {
  for (const item of [...usagePollers.values()]) item.stop();
  usagePollers.clear();
  loadingUsage.clear();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function health(left: number, time: number) {
  return left - time;
}

function boost(left: number, time: number) {
  const scaled = clamp(health(left, time) / HEALTH_RANGE, -1, 1);
  if (scaled >= 0) return 1 + HEALTH_BONUS * scaled;
  return 1 + HEALTH_PENALTY * scaled;
}

function weight(plan?: string) {
  const key = plan?.toLowerCase();
  if (key === "pro") return PRO_PLAN_WEIGHT;
  if (key === "plus") return 1;
  if (key === "team") return 1;
  return 1;
}

function mirror(
  client: Client,
  row: {
    id: string;
    access_token: string;
    refresh_token: string;
    expires_at: number;
  },
) {
  return client.auth.set({
    path: { id: "openai" },
    body: {
      type: "oauth",
      refresh: row.refresh_token,
      access: row.access_token,
      expires: row.expires_at,
    } satisfies Auth,
  });
}

function copy(input: RequestInfo | URL, init?: HeadersInit) {
  const headers = new Headers(
    input instanceof Request ? input.headers : undefined,
  );
  const next = new Headers(init);

  next.forEach((value, key) => {
    headers.set(key, value);
  });

  headers.delete("authorization");
  headers.delete("Authorization");
  return headers;
}

function name(row: Row) {
  return row.label || row.email || row.id.slice(0, 8);
}

function ago(at: number) {
  const secs = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (secs < 60) return `${secs}s ago`;

  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.floor(hours / 24)}d ago`;
}

function role(row: Row): "core" | "pool" {
  return row.primary === 1 ? "core" : "pool";
}

function plan(row: Row) {
  return row.plan_type ?? "unknown";
}

function resetDeadline(hit: UsageHit) {
  const list = [
    hit.body.rate_limit?.primary_window,
    hit.body.rate_limit?.secondary_window,
  ].flatMap((win) => {
    if (!win) return [];

    const used = win.used_percent;
    if (typeof used !== "number" || !Number.isFinite(used)) return [];

    const after = win.reset_after_seconds;
    if (typeof after !== "number" || !Number.isFinite(after) || after < 0) {
      return [];
    }

    const value = clamp(used, 0, 100);
    if (dormant(win, value)) return [];
    return [hit.updated_at + after * 1000];
  });

  if (list.length === 0) return null;
  return Math.min(...list);
}

function resetExpired(hit: UsageHit) {
  const at = resetDeadline(hit);
  if (at === null) return false;
  return Date.now() >= at;
}

function cachedInfo(store: Store, row: Row, maxAgeMs: number) {
  const hit = store.usageInfo(row.id, maxAgeMs);
  if (hit === undefined) return undefined;
  if (resetExpired(hit)) return undefined;
  return hit;
}

function usageView(store: Store, row: Row, warm = false): UsageView {
  const fresh = cachedInfo(store, row, QUOTA_CACHE_MS);
  if (fresh !== undefined) {
    return {
      body: fresh.body,
      source: "fresh",
      at: fresh.updated_at,
    };
  }

  const stale = cachedInfo(store, row, STALE_QUOTA_MS);
  if (warm) void loadUsage(store, row);
  if (stale !== undefined) {
    return {
      body: stale.body,
      source: "stale",
      at: stale.updated_at,
    };
  }

  return {
    source: "missing",
  };
}

function quota(store: Store, row: Row, warm = false): ScoreView {
  const usage = usageView(store, row, warm);
  const hit = usage.body ? score(usage.body) : null;

  return {
    id: row.id,
    name: name(row),
    plan: plan(row),
    role: role(row),
    score: hit?.score ?? undefined,
    source: usage.source,
    deciding: hit?.label,
    windows: hit?.windows ?? [],
    main: hit?.main,
    guard: hit?.guard,
    age: usage.source === "stale" && usage.at !== undefined ? ago(usage.at) : undefined,
  };
}

function text(item: ScoreView, scoreWidth: number) {
  if (item.main && item.guard && item.score !== undefined) {
    return [
      item.score.toFixed(3).padStart(scoreWidth),
      `(${item.main.score.toFixed(3).padStart(scoreWidth)} * guard x${item.guard.factor.toFixed(3)})`,
    ].join(" ");
  }

  if (item.windows.length > 0) {
    return item.windows
      .map((win) => `[${win.name}] ${win.score.toFixed(3).padStart(scoreWidth)}`)
      .join(" ");
  }

  if (item.score === undefined) {
    return "n/a";
  }

  const score = (item.score?.toFixed(3) ?? "n/a").padStart(scoreWidth);
  return score;
}

function title(item: ScoreView) {
  const tags = [
    item.source === "stale" ? item.age ?? "cached" : null,
    item.score === 0 ? "blocked" : null,
  ].filter((value): value is string => value !== null);
  if (tags.length === 0) return item.name;
  return `${item.name} (${tags.join(", ")})`;
}

function line(
  item: ScoreView,
  pick: string,
  planWidth: number,
  scoreWidth: number,
) {
  const head = item.id === pick ? ">" : " ";
  const tier = `[${item.plan}]`.padEnd(planWidth + 2);
  const prefix = `${head} ${tier} ${title(item)}:`;
  if (item.windows.length === 0) return `${prefix} ${text(item, scoreWidth)}`;
  return `${prefix}\n    ${text(item, scoreWidth)}`;
}

function describe(scores: ScoreView[], reason: string, pick: string) {
  const planWidth = Math.max(...scores.map((item) => item.plan.length));
  const scoreWidth = Math.max(
    0,
    ...scores.flatMap((item) => {
      if (item.main && item.guard && item.score !== undefined) {
        return [item.score, item.main.score].map((value) => value.toFixed(3).length);
      }

      if (item.windows.length > 0) {
        return item.windows.map((win) => win.score.toFixed(3).length);
      }

      return item.source === "missing"
        ? [0]
        : [(item.score?.toFixed(3) ?? "n/a").length];
    }),
  );
  const lines = [
    scores.length === 1 ? "Account:" : "Accounts:",
    ...scores.map((item) => line(item, pick, planWidth, scoreWidth)),
    `Because: ${reason}`,
  ];
  return lines.join("\n");
}

function signed(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function span(secs: number) {
  if (secs >= 86_400) {
    const value = secs / 86_400;
    return `${Number.isInteger(value) ? value : value.toFixed(1).replace(/\.0$/, "")}d`;
  }

  if (secs >= 3_600) {
    const value = secs / 3_600;
    return `${Number.isInteger(value) ? value : value.toFixed(1).replace(/\.0$/, "")}h`;
  }

  if (secs >= 60) {
    const value = secs / 60;
    return `${Number.isInteger(value) ? value : value.toFixed(1).replace(/\.0$/, "")}m`;
  }

  return `${secs.toFixed(0)}s`;
}

function fastTarget(label: string, win?: Window) {
  const extra = /^extra(\d+)\.(primary|secondary)$/.exec(label);
  if (!extra) return label;

  const item = readyWindow(win);
  const hint = item ? ` (${span(item.limit_window_seconds)})` : "";
  return `additional ${extra[1]} ${extra[2]}${hint}`;
}

function windowName(label: string, win?: Window) {
  const item = readyWindow(win);
  if (!item) return label;
  return span(item.limit_window_seconds);
}

function dedupeWindows<T extends ScoreWindow>(items: T[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  }

  return items.map((item) => {
    if ((counts.get(item.name) ?? 0) < 2) return item;
    const side = item.label.split(".").at(-1);
    if (!side) return item;
    return {
      ...item,
      name: `${item.name} ${side}`,
    } satisfies T;
  });
}

function fastLimitTarget(label: string) {
  const extra = /^extra(\d+)$/.exec(label);
  if (!extra) return label;
  return `additional ${extra[1]}`;
}

function fastOff(info: FastView) {
  if (info.rule === "manual") return "Fast: disabled (manual tier)";
  if (info.rule === "blocked") return "Fast: disabled (blocked)";
  if (info.rule === "no data") return "Fast: disabled (no data)";
  if (info.rule === "low cap") {
    return info.target
      ? `Fast: disabled (cap<3%, ${info.target})`
      : "Fast: disabled (cap<3%)";
  }
  if (info.rule === "low score" && typeof info.score === "number") {
    if (
      info.main?.state === "scored" &&
      typeof info.main.score === "number" &&
      typeof info.cost === "number" &&
      info.cost > 0
    ) {
      return `Fast: disabled (low score ${signed(info.score)} (${signed(info.main.score)} - guard ${info.cost.toFixed(3)}))`;
    }
    return `Fast: disabled (low score ${signed(info.score)})`;
  }
  return `Fast: disabled (${info.rule})`;
}

function fastNote(info: FastView) {
  if (!info.fast) return fastOff(info);
  if (typeof info.score !== "number") return "Fast: enabled";
  if (
    info.main?.state === "scored" &&
    typeof info.main.score === "number" &&
    typeof info.cost === "number" &&
    info.cost > 0
  ) {
    return `Fast: enabled ${signed(info.score)} (${signed(info.main.score)} - guard ${info.cost.toFixed(3)})`;
  }
  return `Fast: enabled ${signed(info.score)}`;
}

function selectionToast(
  client: Client,
  scores: ScoreView[],
  reason: string,
  pick: string,
  note: string,
) {
  const detail = describe(scores, reason, pick);
  void client.tui.showToast({
    body: {
      title: "Codex Pool",
      message: `${detail}\n\n${note}`,
      variant: "info",
      duration: 10_000,
    },
  });
}

function fetchingToast(client: Client) {
  void client.tui.showToast({
    body: {
      title: "Codex Pool",
      message: "Quota cache expired, fetching usage before selection",
      variant: "info",
      duration: 10_000,
    },
  });
}

function flipToast(client: Client, score: ScoreView, note: string) {
  const detail = describe([score], "sticky session kept account", score.id);
  void client.tui.showToast({
    body: {
      title: "Codex Pool",
      message: `${detail}\n\n${note}`,
      variant: "info",
      duration: 10_000,
    },
  });
}

function listed(scores: ScoreView[], item: ScoreView) {
  return scores.some((score) => score.id === item.id) ? scores : [...scores, item];
}

function rewrite(input: RequestInfo | URL) {
  const src =
    input instanceof URL
      ? input.href
      : input instanceof Request
        ? input.url
        : input;
  const url = new URL(src);

  if (
    url.pathname.includes("/v1/responses") ||
    url.pathname.includes("/chat/completions")
  ) {
    return new URL(CODEX_API_ENDPOINT);
  }

  return url;
}

function wait(res: Response) {
  const raw = res.headers.get("retry-after");
  if (!raw) return 60_000;

  const secs = Number(raw);
  if (Number.isFinite(secs) && secs > 0) return secs * 1000;

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return 60_000;
  return Math.max(at - Date.now(), 1000);
}

function reset(win: Window) {
  const after = win.reset_after_seconds;
  if (typeof after === "number" && Number.isFinite(after) && after > 0) return after;

  const span = win.limit_window_seconds;
  if (typeof span === "number" && Number.isFinite(span) && span > 0) return span;
  return null;
}

function conservation(secs: number) {
  return Math.max(
    1,
    Math.min(CONSERVATION_CAP, 1 + Math.log(secs / CONSERVATION_REF)),
  );
}

function dormant(win: Window, used: number) {
  if (used > 0) return false;

  const after = win.reset_after_seconds;
  if (typeof after !== "number" || !Number.isFinite(after) || after <= 0) return false;

  const span = win.limit_window_seconds;
  if (typeof span !== "number" || !Number.isFinite(span) || span <= 0) return false;

  return Math.abs(span - after) <= DORMANT_SLACK;
}

function windowScore(win: Window | undefined, plan: number) {
  if (!win) return null;
  if (typeof win.used_percent !== "number") return null;
  if (!Number.isFinite(win.used_percent)) return null;

  const used = Math.min(Math.max(win.used_percent, 0), 100);
  const left = 1 - used / 100;
  const secs = reset(win);
  if (secs === null) return null;

  const span = win.limit_window_seconds;
  if (typeof span === "number" && Number.isFinite(span) && span > 0) {
    const cap = Math.sqrt(span / CAPACITY_REF);
    const time = clamp(secs / span, 0, 1);
    const factor = boost(left, time);
    if (dormant(win, used)) return plan * left * cap * factor;

    const pace = Math.max(time, 0.000001);
    const cons = conservation(secs);
    return ((plan * left * cap) / (pace * cons)) * factor;
  }

  return (plan * left) / secs;
}

function blocked(limit?: Limit) {
  if (!limit) return false;
  if (limit.allowed === false) return true;
  return limit.limit_reached === true;
}

function readyWindow(win?: Window): ReadyWindow | null | undefined {
  if (!win) return undefined;
  const used = win.used_percent;
  const after = win.reset_after_seconds;
  const span = win.limit_window_seconds;
  if (typeof used !== "number") return null;
  if (!Number.isFinite(used)) return null;
  if (typeof after !== "number") return null;
  if (!Number.isFinite(after) || after < 0) return null;
  if (typeof span !== "number") return null;
  if (!Number.isFinite(span) || span <= 0) return null;
  return {
    used_percent: used,
    reset_after_seconds: after,
    limit_window_seconds: span,
  };
}

function balanced(win: ReadyWindow): Window {
  const time = clamp(win.reset_after_seconds / win.limit_window_seconds, 0, 1);
  return {
    used_percent: (1 - time) * 100,
    reset_after_seconds: win.reset_after_seconds,
    limit_window_seconds: win.limit_window_seconds,
  } satisfies Window;
}

function normalized(win: ReadyWindow, plan: number) {
  const raw = windowScore(win, plan);
  if (typeof raw !== "number" || raw <= 0) return null;
  const base = windowScore(balanced(win), plan);
  if (typeof base !== "number" || base <= 0) return null;
  return {
    raw,
    base,
    score: Math.log(raw / base),
  };
}

function inspectFastWindow(label: string, win?: Window, plan = 1): FastWindowView | undefined {
  if (!win) return undefined;

  const item = readyWindow(win);
  if (item === null) {
    return {
      label,
      target: fastTarget(label, win),
      state: "incomplete",
    } satisfies FastWindowView;
  }

  if (item === undefined) return undefined;
  const used = clamp(item.used_percent, 0, 100);
  const left = 1 - used / 100;
  const idle = dormant(item, used);
  if (left < FAST_MIN_LEFT) {
    return {
      label,
      target: fastTarget(label, win),
      state: "floor",
      left,
      dormant: idle,
    } satisfies FastWindowView;
  }

  const hit = normalized(item, plan);
  if (!hit) {
    return {
      label,
      target: fastTarget(label, win),
      state: "incomplete",
    } satisfies FastWindowView;
  }

  return {
    label,
    target: fastTarget(label, win),
    state: "scored",
    score: hit.score,
    raw: hit.raw,
    base: hit.base,
    left,
    span: item.limit_window_seconds,
    dormant: idle,
  } satisfies FastWindowView;
}

function inspectFastLimit(label: string, limit: Limit | undefined, plan: number): FastWindowView[] {
  if (!limit) return [];
  if (blocked(limit)) {
    return [
      {
        label,
        target: fastLimitTarget(label),
        state: "blocked",
      } satisfies FastWindowView,
    ];
  }

  const rows: FastWindowView[] = [];
  const primary = inspectFastWindow(`${label}.primary`, limit.primary_window, plan);
  if (primary) rows.push(primary);
  const secondary = inspectFastWindow(`${label}.secondary`, limit.secondary_window, plan);
  if (secondary) rows.push(secondary);
  return rows;
}

function inspectFastUsage(usage: Usage) {
  const plan = weight(usage.plan_type);
  return [...inspectFastLimit("rate", usage.rate_limit, plan)];
}

function profile(windows: FastWindowView[]): FastProfile | null {
  const rate = windows.filter(
    (item): item is FastWindowView & { score: number; span: number } =>
      item.label.startsWith("rate.") &&
      item.state === "scored" &&
      typeof item.score === "number" &&
      typeof item.span === "number",
  );
  if (rate.length === 0) return null;

  const main = rate.reduce((best, item) => (item.span > best.span ? item : best));
  const guards = windows.filter(
    (item): item is FastWindowView & { score: number; span: number } =>
      item.label !== main.label &&
      item.state === "scored" &&
      typeof item.score === "number" &&
      typeof item.span === "number",
  );
  const guard = guards.reduce<FastProfile["guard"]>((worst, item) => {
    if (!worst) return item;
    const score = worst.score ?? Number.POSITIVE_INFINITY;
    return item.score < score ? item : worst;
  }, undefined);
  const cost = Math.max(0, -(guard?.score ?? 0));
  return {
    main,
    guard,
    score: main.score - cost,
    cost,
    guards,
  } satisfies FastProfile;
}

function inspectFast(usage: Usage, previous?: boolean): FastView {
  const windows = inspectFastUsage(usage);
  const rate = windows.filter((item) => item.label.startsWith("rate."));

  if (rate.length === 0) {
    return {
      fast: false,
      rule: "no data",
      target: "rate limit",
      windows,
    };
  }

  const blocked = windows.find((item) => item.state === "blocked");
  if (blocked) {
    return {
      fast: false,
      rule: "blocked",
      target: blocked.target,
      windows,
    };
  }

  const incomplete = windows.find((item) =>
    item.label.startsWith("rate.") && item.state === "incomplete",
  );
  if (incomplete) {
    return {
      fast: false,
      rule: "no data",
      target: incomplete.target,
      windows,
    };
  }

  const floor = windows.find((item) => item.state === "floor");
  if (floor) {
    return {
      fast: false,
      rule: "low cap",
      target: floor.target,
      detail: floor,
      windows,
    };
  }

  const hit = profile(windows);
  if (!hit) {
    return {
      fast: false,
      rule: "no data",
      windows,
    };
  }

  const gate = previous ? FAST_SCORE_OFF : FAST_SCORE_ON;
  const fast = hit.score >= gate;
  return {
    fast,
    rule: fast ? "ok" : "low score",
    score: hit.score,
    detail: hit.guard,
    main: hit.main,
    guards: hit.guards,
    cost: hit.cost,
    windows,
  };
}

function explainFast(
  input: RequestInfo | URL,
  parsed: JsonBody | undefined,
  usage: Usage | null,
  previous?: boolean,
): FastView {
  const url = rewrite(input).toString();
  if (url !== CODEX_API_ENDPOINT) {
    return {
      fast: false,
      rule: "no data",
      target: "request",
      windows: [],
    };
  }

  if (!parsed) {
    return {
      fast: false,
      rule: "no data",
      target: "request body",
      windows: [],
    };
  }

  if (parsed.tier) {
    return {
      fast: false,
      rule: "manual",
      target: "caller tier",
      windows: [],
    };
  }

  if (!usage) {
    return {
      fast: false,
      rule: "no data",
      target: "usage",
      windows: [],
    };
  }

  return inspectFast(usage, previous);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseBody(body: ArrayBuffer | null) {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(decoder.decode(body));
    if (!object(parsed)) return undefined;
    return {
      body: parsed,
      tier: "service_tier" in parsed || "serviceTier" in parsed,
    } satisfies JsonBody;
  } catch {
    return undefined;
  }
}

function withPriority(parsed: JsonBody | undefined) {
  if (!parsed || parsed.tier) return undefined;
  return {
    ...parsed.body,
    service_tier: "priority",
  } satisfies Record<string, unknown>;
}

async function snapshot(input: RequestInfo | URL, init?: RequestInit) {
  const src =
    init?.body ?? (input instanceof Request ? input.clone().body ?? undefined : undefined);
  if (!src) return null;
  if (src instanceof ArrayBuffer) return src.slice(0);
  if (ArrayBuffer.isView(src)) {
    return src.buffer.slice(
      src.byteOffset,
      src.byteOffset + src.byteLength,
    ) as ArrayBuffer;
  }
  return await new Response(src).arrayBuffer();
}

function rankWindow(label: string, win: Window | undefined, plan: number): RankWindow | null {
  const score = windowScore(win, plan);
  if (score === null) return null;
  const ready = readyWindow(win);
  return {
    label,
    name: windowName(label, win),
    score,
    ready: ready ?? undefined,
    span: ready?.limit_window_seconds,
  } satisfies RankWindow;
}

function guardScore(win: RankWindow): ScoreGuard | null {
  if (!win.ready) return null;
  const used = clamp(win.ready.used_percent, 0, 100);
  const left = 1 - used / 100;
  const floor = left < FAST_MIN_LEFT ? left / FAST_MIN_LEFT : 1;
  const hit = normalized(win.ready, 1);
  if (!hit) {
    return {
      label: win.label,
      name: win.name,
      factor: floor,
      score: 0,
    } satisfies ScoreGuard;
  }

  const debt = Math.max(0, -hit.score);
  return {
    label: win.label,
    name: win.name,
    factor: Math.min(floor, 1 / (1 + debt)),
    score: hit.score,
  } satisfies ScoreGuard;
}

function reduceScore(list: RankWindow[]): ScoreHit | null {
  if (list.length < 2) return null;
  const full = list.filter(
    (item): item is RankWindow & { ready: ReadyWindow; span: number } =>
      item.ready !== undefined && typeof item.span === "number",
  );
  if (full.length < 2) return null;

  const main = full.reduce((best, item) => (item.span > best.span ? item : best));
  const guards = full.filter((item) => item.label !== main.label && item.span < main.span);
  if (guards.length === 0) return null;

  const guard = guards.reduce<ScoreGuard | undefined>((worst, item) => {
    const next = guardScore(item);
    if (!next) return worst;
    if (!worst) return next;
    return next.factor < worst.factor ? next : worst;
  }, undefined);
  if (!guard) return null;

  return {
    score: main.score * guard.factor,
    label: guard.factor < 1 ? guard.label : main.label,
    windows: list,
    main: {
      label: main.label,
      name: main.name,
      score: main.score,
    } satisfies ScoreWindow,
    guard,
  } satisfies ScoreHit;
}

function limitScore(label: string, limit: Limit | undefined, plan: number): ScoreHit | null {
  if (!limit) return null;
  if (blocked(limit)) return { score: 0, label, windows: [] };

  const list = dedupeWindows(
    [
      rankWindow(`${label}.primary`, limit.primary_window, plan),
      rankWindow(`${label}.secondary`, limit.secondary_window, plan),
    ].filter(
      (item): item is RankWindow => item !== null,
    ),
  );

  if (list.length === 0) return null;

  const reduced = reduceScore(list);
  if (reduced) return reduced;

  const best = list.reduce((win, item) => (item.score < win.score ? item : win));
  return {
    score: best.score,
    label: best.label,
    windows: list,
  };
}

function score(body: Usage): ScoreHit | null {
  const plan = weight(body.plan_type);
  const list = [limitScore("rate", body.rate_limit, plan)];

  const blocked = list.find((item) => item?.score === 0);
  if (blocked) return blocked;

  const values = list.filter(
    (item): item is ScoreHit => item !== null,
  );

  if (values.length === 0) return null;
  return values.reduce((best, item) =>
    (item.score ?? Number.POSITIVE_INFINITY) <
    (best.score ?? Number.POSITIVE_INFINITY)
      ? item
      : best,
  );
}

function cachedUsage(store: Store, row: Row) {
  return usageView(store, row).body ?? null;
}

function usageSource(store: Store, row: Row): UsageSource {
  return usageView(store, row).source;
}

function expiredUsage(store: Store, row: Row) {
  return usageSource(store, row) === "missing" && store.hasUsage(row.id);
}

async function fetchExpiredUsage(store: Store, rows: Row[], client: Client) {
  const expired = rows.filter((row) => expiredUsage(store, row));
  if (expired.length === 0) return false;
  fetchingToast(client);
  await Promise.all(rows.map((row) => loadUsage(store, row)));
  return true;
}

async function waitUsage(store: Store, row: Row, maxAgeMs: number) {
  const tries = Math.max(1, Math.ceil(USAGE_FETCH_WAIT_MS / 250));

  for (let i = 0; i < tries; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    const cached = cachedInfo(store, row, maxAgeMs);
    if (cached !== undefined) return cached.body;
  }

  return undefined;
}

async function loadUsage(store: Store, row: Row, maxAgeMs = QUOTA_CACHE_MS) {
  const account = row.chatgpt_account_id;
  if (!account) return null;

  const cached = cachedInfo(store, row, maxAgeMs);
  if (cached !== undefined) return cached.body;

  const held = loadingUsage.get(row.id);
  if (held) return held;

  const load = (async () => {
    const key = `usage:${row.id}`;
    const owner = crypto.randomUUID();
    let locked = store.acquireLock(key, owner, USAGE_FETCH_LEASE_MS);

    if (!locked) {
      const shared = await waitUsage(store, row, maxAgeMs);
      if (shared !== undefined) return shared;

      locked = store.acquireLock(key, owner, USAGE_FETCH_LEASE_MS);
      if (!locked) {
        return cachedInfo(store, row, STALE_QUOTA_MS)?.body ?? null;
      }
    }

    try {
      const shared = cachedInfo(store, row, maxAgeMs);
      if (shared !== undefined) return shared.body;

      const headers = new Headers();
      headers.set("authorization", `Bearer ${row.access_token}`);
      headers.set("accept", "application/json");
      headers.set("ChatGPT-Account-Id", account);

      const res = await fetch(CODEX_USAGE_ENDPOINT, { headers });
      if (!res.ok) return null;
      const usage = ((await res.json()) as Usage) ?? {};
      store.cacheUsage(row.id, usage);
      if (usage.plan_type) store.updatePlanType(row.id, usage.plan_type);
      return usage;
    } catch {
      return null;
    } finally {
      if (locked) store.releaseLock(key, owner);
      loadingUsage.delete(row.id);
    }
  })();

  loadingUsage.set(row.id, load);
  return load;
}

function attempt(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  parsed: JsonBody | undefined,
  usage: Usage | null,
  previous?: boolean,
) : AttemptResult {
  const info = explainFast(input, parsed, usage, previous);
  const url = rewrite(input).toString();
  if (url !== CODEX_API_ENDPOINT) {
    return { init, fast: false, note: fastNote(info) };
  }
  const body = withPriority(parsed);
  if (!body) return { init, fast: false, note: fastNote(info) };
  if (!usage || !info.fast) {
    return { init, fast: false, note: fastNote(info) };
  }
  return {
    init: {
      ...init,
      body: new TextEncoder().encode(JSON.stringify(body)).buffer,
    } satisfies RequestInit,
    fast: true,
    note: fastNote(info),
  };
}

function pick(store: Store) {
  store.clearExpired();
  return store.available()[0] ?? store.primary() ?? store.list()[0];
}

async function ready(store: Store, row: Row, client: Client) {
  if (row.expires_at > Date.now()) return row;

  try {
    return await renew(store, row, client);
  } catch {
    return row;
  }
}

function createUsagePoller(
  store: Store,
  client: Client,
  release: () => void,
): UsagePoller {
  const seen = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let run: Promise<void> | undefined;
  let stopped = false;
  let poller: UsagePoller;

  function prune() {
    const min = Date.now() - USAGE_ACTIVE_MS;

    for (const [id, at] of seen) {
      if (at < min) seen.delete(id);
    }
  }

  function schedule() {
    if (stopped || timer || run || seen.size === 0) return;

    timer = scheduleTimeout(() => {
      timer = undefined;
      void sweep();
    }, USAGE_POLL_MS);
    timer.unref?.();
  }

  async function sweep() {
    if (run) return run;

    run = (async () => {
      try {
        if (stopped) return;

        prune();
        if (seen.size === 0) return;

        const rows = await Promise.all(
          store
            .available()
            .filter((row) => seen.has(row.id) && row.chatgpt_account_id)
            .map((row) => ready(store, row, client)),
        );

        await Promise.all(
          rows.map((row) => {
            if (store.usage(row.id, USAGE_REVALIDATE_MS) !== undefined) {
              return Promise.resolve(null);
            }

            return loadUsage(store, row, USAGE_REVALIDATE_MS);
          }),
        );
      } finally {
        run = undefined;
        if (!stopped) {
          prune();
          schedule();
        }
      }
    })();

    return run;
  }

  poller = {
    touch(rows) {
      if (stopped) return;

      const now = Date.now();
      for (const row of rows) {
        if (!row.chatgpt_account_id) continue;
        seen.set(row.id, now);
      }

      prune();
      schedule();
    },

    async flush() {
      if (timer) {
        cancelTimeout(timer);
        timer = undefined;
      }

      await sweep();
    },

    stop() {
      stopped = true;
      seen.clear();
      if (timer) cancelTimeout(timer);
      timer = undefined;
      release();
    },
  };

  return poller;
}

function useUsagePoller(store: Store, client: Client) {
  const held = usagePollers.get(store);
  if (held) return held;

  const poller = createUsagePoller(store, client, () => {
    if (usagePollers.get(store) === poller) usagePollers.delete(store);
  });

  usagePollers.set(store, poller);

  if (!usageClose.has(store)) {
    const close = store.close.bind(store);
    store.close = () => {
      usagePollers.get(store)?.stop();
      close();
    };
    usageClose.add(store);
  }

  return poller;
}

function rank(
  store: Store,
  rows: Row[],
  affinity: Affinity,
  warm = true,
): RankResult {
  if (rows.length <= 1) {
    return {
      rows,
      scores: rows.map((row) => quota(store, row)),
      reason: rows.length === 1 ? "only available account" : undefined,
    };
  }

  if (!store.primary() && rows.every((row) => row.primary !== 1)) {
    return {
      rows,
      scores: rows.map((row) => quota(store, row)),
    };
  }

  const list = rows.map((row) => quota(store, row, warm));
  if (list.some((item) => item.score === undefined)) {
    return {
      rows,
      scores: list,
      reason: "quota cache warming",
    };
  }

  const scores = new Map(list.map((item) => [item.id, item.score ?? 0]));
  const ordered = order(rows, scores);
  const top = ordered[0];
  const next = ordered[1];
  if (!top) {
    return {
      rows,
      scores: list,
    };
  }

  if (active(affinity)) {
    const stick = rows.find((row) => row.id === affinity.id);
    const base = stick ? scores.get(stick.id) ?? 0 : 0;
    const alt = stick ? ordered.find((row) => row.id !== stick.id) : undefined;
    const best = alt ? scores.get(alt.id) ?? 0 : 0;

    if (stick && alt && base > 0) {
      const hi = Math.max(base, best, 0.001);
      const margin = SWITCH_MARGIN * (0.5 + 0.5 * Math.min(base, best) / hi);
      if (best > base * (1 + margin)) {
        return {
          rows: ordered,
          scores: list,
          reason: stick.primary === 1 ? "higher score beat sticky core" : "higher score beat sticky pool",
        };
      }

      return {
        rows: place(ordered, stick.id),
        scores: list,
        reason: stick.primary === 1 ? "sticky session kept core" : "sticky session kept pool",
      };
    }
  }

  if ((scores.get(top.id) ?? 0) === (scores.get(next?.id ?? "") ?? -1)) {
    return {
      rows: ordered,
      scores: list,
      reason: "tied score kept priority",
    };
  }

  return {
    rows: ordered,
    scores: list,
    reason: "higher score",
  };
}

async function renew(
  store: Store,
  row: NonNullable<ReturnType<Store["primary"]>>,
  client: Client,
) {
  const key = `refresh:${row.id}`;
  const owner = crypto.randomUUID();

  if (!store.acquireLock(key, owner, REFRESH_LEASE_MS)) {
    // Another instance is refreshing — wait briefly, then re-read from store
    await new Promise((r) => setTimeout(r, 2000));
    const fresh = store.get(row.id);
    if (fresh && fresh.expires_at > Date.now()) return fresh;
    // Lock expired or tokens still stale — proceed with refresh anyway
  }

  try {
    const tokens = await refresh(row.refresh_token);
    const expires = Date.now() + (tokens.expires_in ?? 3600) * 1000;

    store.updateTokens(
      row.id,
      tokens.access_token,
      tokens.refresh_token,
      expires,
    );
    store.clearUsage(row.id);
    loadingUsage.delete(row.id);
    store.enable(row.id);
    store.clearCooldown(row.id);

    if (store.primary()?.id === row.id) {
      await mirror(client, {
        id: row.id,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expires,
      });
    }

    return (
      store.get(row.id) ?? {
        ...row,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expires,
      }
    );
  } finally {
    store.releaseLock(key, owner);
  }
}

async function send(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  row: NonNullable<ReturnType<Store["primary"]>>,
) {
  const headers = copy(input, init?.headers);
  headers.set("authorization", `Bearer ${row.access_token}`);

  if (row.chatgpt_account_id) {
    headers.set("ChatGPT-Account-Id", row.chatgpt_account_id);
  }

  const req =
    input instanceof Request
      ? new Request(rewrite(input), input)
      : rewrite(input);

  return fetch(req, {
    ...init,
    headers,
  });
}

export function createFetch(
  store: Store,
  getAuth: () => Promise<Auth>,
  client: Client,
) {
  const sessions = new Map<string, Affinity>();
  const poller = useUsagePoller(store, client);

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const auth = await getAuth();
    if (auth.type !== "oauth") return fetch(input, init);

    let body: ArrayBuffer | null = null;
    body = await snapshot(input, init);
    const snap = body ? { ...init, body } : init;
    const parsed = parseBody(body);
    const candidate = withPriority(parsed);

    const session = cacheKey(body);
    let affinity: Affinity = { at: 0 };
    if (session) {
      const entry = sessions.get(session);
      if (entry) {
        affinity = entry;
      } else {
        affinity = { at: 0 };
        sessions.set(session, affinity);
      }
      if (sessions.size > 50) {
        const now = Date.now();
        for (const [k, v] of sessions) {
          if (now - v.at >= AFFINITY_MS) sessions.delete(k);
          }
        }
      }

    const rows = await Promise.all(
      store.available().map((item) => ready(store, item, client)),
    );
    poller.touch(rows);
    const prefetched = await fetchExpiredUsage(store, rows, client);
    const ranked = rank(store, rows, affinity, !prefetched);
    const ordered = ranked.rows;
    const list =
      ordered.length > 0
        ? ordered
        : [pick(store)].filter((row) => row !== undefined);

    if (candidate && list.length === 1) {
      const state = usageSource(store, list[0]);
      if (state === "missing" && !prefetched) {
        await loadUsage(store, list[0]);
      }
      if (state === "stale") {
        void loadUsage(store, list[0]);
      }
    }

    let last: Response | Error | undefined;
    let note: string | undefined;

    for (const item of list) {
      let row = item;

      try {
        if (row.expires_at <= Date.now()) {
          row = await renew(store, row, client);
        }

        const state = usageSource(store, row);
        if (state === "stale") void loadUsage(store, row);
        const current = quota(store, row);
        const sticky = active(affinity);
        let used = attempt(
          input,
          snap,
          parsed,
          cachedUsage(store, row),
          sticky && affinity.id === row.id ? affinity.fast : undefined,
        );
        if (!sticky || affinity.id !== row.id) {
          const scores = listed(
            ranked.scores.length > 0 ? ranked.scores : [quota(store, row)],
            current,
          );
          selectionToast(
            client,
            scores,
            note ?? ranked.reason ?? "selected account",
            row.id,
            used.note,
          );
        } else if (affinity.fast !== undefined && affinity.fast !== used.fast) {
          flipToast(client, current, used.note);
        }
        let res = await send(input, used.init, row);

        if (res.status === 401) {
          row = await renew(store, row, client);
          const fresh = quota(store, row);
          used = attempt(
            input,
            snap,
            parsed,
            cachedUsage(store, row),
            sticky && affinity.id === row.id ? affinity.fast : undefined,
          );
          res = await send(input, used.init, row);
        }

        if (res.status === 429) {
          const ms = wait(res);
          note = `${name(row)} hit 429 cooldown`;
          store.setCooldown(
            row.id,
            Date.now() + ms,
            res.status,
            res.statusText || "rate_limited",
            ms,
          );
          last = res;
          continue;
        }

        if (res.status === 401) {
          note = `${name(row)} stayed unauthorized`;
          store.disable(row.id, res.statusText || "unauthorized");
          last = res;
          continue;
        }

        if (res.ok) {
          store.enable(row.id);
          store.clearCooldown(row.id);
          if (session) {
            affinity.id = row.id;
            affinity.at = Date.now();
            affinity.fast = used.fast;
          }
        }

        return res;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        note = `${name(row)} errored`;
        last = err instanceof Error ? err : new Error(msg);
      }
    }

    if (last instanceof Response) return last;
    if (last) throw last;
    return fetch(input, init);
  };
}
