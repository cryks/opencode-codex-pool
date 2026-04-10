import type { Auth } from "@opencode-ai/sdk";
import type { PluginInput } from "@opencode-ai/plugin";

import {
  DEFAULT_CONFIG,
  type FastMode,
  type PoolConfig,
  type StickyMode,
} from "./config";
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
const SWITCH_MARGIN = 0.35;
const AFFINITY_MS = 300_000;
const DORMANT_TOUCH_MS = 30 * 60 * 1000;
const CONSERVATION_CAP = 1 + Math.log(CONSERVATION_HORIZON / CONSERVATION_REF);
const PROLITE_PLAN_WEIGHT = Math.sqrt(5);
const PRO_PLAN_WEIGHT = Math.sqrt(20);

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

function active(affinity: Affinity, mode: StickyMode) {
  if (mode === "disabled") return false;
  return Boolean(affinity.id) && Date.now() - affinity.at < AFFINITY_MS;
}

function touching(mode: PoolConfig["dormantTouch"], sticky: boolean) {
  if (mode === "disabled") return false;
  if (mode === "new-session-only") return !sticky;
  return true;
}

type ScoreSource = "fresh" | "stale" | "missing";
type UsageSource = "fresh" | "stale" | "missing";

interface UsageView {
  body?: Usage;
  source: UsageSource;
  at?: number;
}

function cacheAge(at?: number) {
  if (at === undefined) return 0;
  return Math.max(0, (Date.now() - at) / 1000);
}

interface ScoreView {
  id: string;
  name: string;
  plan: string;
  role: "core" | "pool";
  score?: number;
  blockedFor?: number;
  source: ScoreSource;
  touches: string[];
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
  weight?: number;
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

interface GuardView {
  label: string;
  name: string;
  ready: ReadyWindow;
  floor: number;
  score: number;
}

interface ScoreHit {
  score: number | null;
  blockedFor?: number;
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
  ready?: ReadyWindow;
}

interface FastGuardView extends FastWindowView {
  ready: ReadyWindow;
  score: number;
  span: number;
  cost: number;
  weight: number;
}

interface FastView {
  fast: boolean;
  rule: string;
  target?: string;
  score?: number;
  gate?: number;
  detail?: FastWindowView;
  windows: FastWindowView[];
  main?: FastWindowView;
  guards?: FastWindowView[];
  cost?: number;
}

interface FastProfile {
  main: FastWindowView;
  guard?: FastGuardView;
  score: number;
  cost: number;
  guards: FastWindowView[];
}

interface JsonBody {
  body: Record<string, unknown>;
  tier: boolean;
}

interface TouchWindow {
  label: string;
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
  if (key === "prolite") return PROLITE_PLAN_WEIGHT;
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

function shortPlan(plan?: string | null) {
  const key = plan?.toLowerCase();
  if (key === "prolite") return "pro5";
  if (key === "pro") return "pro20";
  return plan ?? "unknown";
}

function plan(row: Row) {
  return shortPlan(row.plan_type);
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

function quota(
  store: Store,
  row: Row,
  config: PoolConfig,
  sticky: boolean,
  warm = false,
): ScoreView {
  const usage = usageView(store, row, warm);
  const hit = usage.body ? score(usage.body, cacheAge(usage.at)) : null;
  const touched = new Set(store.dormantTouches(row.id));

  return {
    id: row.id,
    name: name(row),
    plan: plan(row),
    role: role(row),
    score: hit?.score ?? undefined,
    blockedFor: hit?.blockedFor,
    source: usage.source,
    touches: touching(config.dormantTouch, sticky)
      ? pendingTouches(touched, usage.body).map((item) => item.label)
      : [],
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
    item.score === 0 ? blockedLabel(item.blockedFor) : null,
  ].filter((value): value is string => value !== null);
  if (tags.length === 0) return item.name;
  return `${item.name} (${tags.join(", ")})`;
}

function blockedLabel(secs?: number) {
  if (typeof secs !== "number") return "blocked";
  return `blocked ${clock(secs)}`;
}

function clock(secs: number) {
  const mins = Math.max(0, Math.ceil(secs / 60));
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours === 0) return `${rest}m`;
  return `${hours}h ${rest}m`;
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
  if (item.windows.length === 0 && item.score !== 0) return `${prefix} ${text(item, scoreWidth)}`;
  return `${prefix}\n    ${text(item, scoreWidth)}`;
}

function touchReason(touches: string[]) {
  if (touches.length === 0) return "untouched dormant window";
  if (touches.length === 1) return `touch dormant ${touches[0]}`;
  return `touch dormant windows (${touches.join(", ")})`;
}

function touchScore(touches: string[]) {
  if (touches.includes("rate.secondary")) return 2;
  if (touches.includes("rate.primary")) return 1;
  return 0;
}

function orderTouches(rows: Row[], scores: Map<string, number>, touches: Map<string, number>) {
  return [...rows].sort((a, b) => {
    const left = touches.get(a.id) ?? 0;
    const right = touches.get(b.id) ?? 0;
    if (left !== right) return right - left;

    const low = scores.get(a.id) ?? 0;
    const high = scores.get(b.id) ?? 0;
    if (low !== high) return high - low;
    return a.priority - b.priority;
  });
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
  const num = Number(value.toFixed(3)) * 100;
  return `${num >= 0 ? "+" : ""}${num.toFixed(3)}`;
}

function fastMargin(score: number, gate?: number) {
  return typeof gate === "number" ? score - gate : score;
}

function fastGate(base: number, bias: number) {
  return base - bias;
}

function gateTerm(gate?: number) {
  if (typeof gate !== "number") return "";
  return ` ${gate >= 0 ? "-" : "+"} gate ${(Math.abs(gate) * 100).toFixed(3)}`;
}

function fastWrap(state: "enabled" | "disabled", score: string, detail?: string) {
  if (!detail) return `Fast: ${state} ${score}`;
  return `Fast: ${state} ${score}\n      (${detail})`;
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
  if (info.rule === "config") return "Fast: disabled (config)";
  if (info.rule === "manual") return "Fast: disabled (manual tier)";
  if (info.rule === "blocked") return "Fast: disabled (blocked)";
  if (info.rule === "no data") return "Fast: disabled (no data)";
  if (info.rule === "low cap") {
    return info.target
      ? `Fast: disabled (cap<3%, ${info.target})`
      : "Fast: disabled (cap<3%)";
  }
  if (info.rule === "low score" && typeof info.score === "number") {
    const delta = signed(fastMargin(info.score, info.gate));
    if (
      info.main?.state === "scored" &&
      typeof info.main.score === "number" &&
      typeof info.cost === "number" &&
      info.cost > 0
    ) {
      const gate = gateTerm(info.gate);
      return fastWrap(
        "disabled",
        delta,
        `${signed(info.main.score)} - guard ${(Number(info.cost.toFixed(3)) * 100).toFixed(3)}${gate}`,
      );
    }
    const gate = gateTerm(info.gate);
    return fastWrap("disabled", delta, `${signed(info.score)}${gate}`);
  }
  return `Fast: disabled (${info.rule})`;
}

function fastNote(info: FastView) {
  if (!info.fast) return fastOff(info);
  if (info.rule === "always") return "Fast: enabled (config)";
  if (typeof info.score !== "number") return "Fast: enabled";
  const delta = signed(fastMargin(info.score, info.gate));
  if (
    info.main?.state === "scored" &&
    typeof info.main.score === "number" &&
    typeof info.cost === "number" &&
    info.cost > 0
  ) {
    const gate = gateTerm(info.gate);
    return fastWrap(
        "enabled",
        delta,
        `${signed(info.main.score)} - guard ${(Number(info.cost.toFixed(3)) * 100).toFixed(3)}${gate}`,
      );
  }
  const gate = gateTerm(info.gate);
  return fastWrap("enabled", delta, `${signed(info.score)}${gate}`);
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

  return span === after;
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

function blockedFor(limit?: Limit, age = 0) {
  if (!limit) return undefined;
  const list = [
    { name: "primary", win: limit.primary_window },
    { name: "secondary", win: limit.secondary_window },
  ]
    .map((item) => ({
      name: item.name,
      used: item.win?.used_percent,
      secs: item.win?.reset_after_seconds,
    }))
    .filter(
      (item): item is { name: "primary" | "secondary"; used: number | undefined; secs: number } =>
        typeof item.secs === "number" && Number.isFinite(item.secs) && item.secs >= 0,
    );
  if (list.length === 0) return undefined;
  const best = list.reduce((win, item) => {
    const left = typeof item.used === "number" && Number.isFinite(item.used) ? item.used : -1;
    const right = typeof win.used === "number" && Number.isFinite(win.used) ? win.used : -1;
    if (left !== right) return left > right ? item : win;
    if (item.name !== win.name) {
      if (item.name === "primary") return item;
      if (win.name === "primary") return win;
    }
    if (item.secs !== win.secs) return item.secs < win.secs ? item : win;
    return win;
  });
  return Math.max(0, best.secs - age);
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

function aged(win: ReadyWindow, age = 0): ReadyWindow {
  if (age <= 0) return win;
  return {
    ...win,
    reset_after_seconds: Math.max(0, win.reset_after_seconds - age),
  } satisfies ReadyWindow;
}

function guardWeight(main: ReadyWindow, guard: ReadyWindow, age = 0) {
  const lead = aged(main, age);
  const follow = aged(guard, age);
  const gap = lead.reset_after_seconds - follow.reset_after_seconds;
  return clamp(gap / follow.limit_window_seconds, 0, 1);
}

function dormantWindow(label: string, win: Window | undefined): TouchWindow | null {
  const ready = readyWindow(win);
  if (!ready) return null;

  const used = clamp(ready.used_percent, 0, 100);
  if (!dormant(ready, used)) return null;
  return {
    label,
  } satisfies TouchWindow;
}

function dormantUsage(usage?: Usage) {
  if (!usage) return [];
  return [
    dormantWindow("rate.primary", usage.rate_limit?.primary_window),
    dormantWindow("rate.secondary", usage.rate_limit?.secondary_window),
  ].filter((item): item is TouchWindow => item !== null);
}

function pendingTouches(touches: Set<string>, usage?: Usage) {
  return dormantUsage(usage).filter((item) => !touches.has(item.label));
}

function rememberTouches(
  store: Store,
  id: string,
  usage: Usage | undefined,
  mode: PoolConfig["dormantTouch"],
) {
  if (mode === "disabled") return;
  for (const item of dormantUsage(usage)) {
    store.touchDormant(id, item.label, Date.now() + DORMANT_TOUCH_MS);
  }
}

function margin(base: number, best: number, strength: number) {
  const hi = Math.max(base, best, 0.001);
  return SWITCH_MARGIN * strength * (0.5 + 0.5 * Math.min(base, best) / hi);
}

function normalized(win: ReadyWindow, plan: number, age = 0) {
  const current = aged(win, age);
  const raw = windowScore(current, plan);
  if (typeof raw !== "number" || raw <= 0) return null;
  const base = windowScore(balanced(current), plan);
  if (typeof base !== "number" || base <= 0) return null;
  return {
    raw,
    base,
    score: Math.log(raw / base),
  };
}

function inspectFastWindow(
  label: string,
  win: Window | undefined,
  plan = 1,
): FastWindowView | undefined {
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
    ready: item,
  } satisfies FastWindowView;
}

function inspectFastLimit(
  label: string,
  limit: Limit | undefined,
  plan: number,
): FastWindowView[] {
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

function profile(windows: FastWindowView[], age = 0): FastProfile | null {
  const rate = windows.filter(
    (item): item is FastWindowView & { score: number; span: number; ready: ReadyWindow } =>
      item.label.startsWith("rate.") &&
      item.state === "scored" &&
      typeof item.score === "number" &&
      typeof item.span === "number" &&
      item.ready !== undefined,
  );
  if (rate.length === 0) return null;

  const main = rate.reduce((best, item) => (item.span > best.span ? item : best));
  const guards = windows.filter(
    (item): item is FastWindowView & { score: number; span: number; ready: ReadyWindow } =>
      item.label !== main.label &&
      item.state === "scored" &&
      typeof item.score === "number" &&
      typeof item.span === "number" &&
      item.ready !== undefined,
  );
  const guard = guards.reduce<FastProfile["guard"]>((worst, item) => {
    const adjusted = normalized(item.ready, 1, age)?.score ?? item.score;
    const weight = guardWeight(main.ready, item.ready, age);
    const cost = weight * Math.max(0, -adjusted);
    const next = {
      ...item,
      score: adjusted,
      cost,
      weight,
    } satisfies FastGuardView;
    if (!worst) return next;
    return cost > worst.cost ? next : worst;
  }, undefined);
  const cost = guard?.cost ?? 0;
  return {
    main,
    guard,
    score: main.score - cost,
    cost,
    guards,
  } satisfies FastProfile;
}

function inspectFast(usage: Usage, bias: number, previous?: boolean, age = 0): FastView {
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

  const hit = profile(windows, age);
  if (!hit) {
    return {
      fast: false,
      rule: "no data",
      windows,
    };
  }

  const gate = fastGate(previous ? FAST_SCORE_OFF : FAST_SCORE_ON, bias);
  const fast = hit.score >= gate;
  return {
    fast,
    rule: fast ? "ok" : "low score",
    score: hit.score,
    gate,
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
  mode: FastMode,
  bias: number,
  previous?: boolean,
  age = 0,
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

  if (mode === "disabled") {
    return {
      fast: false,
      rule: "config",
      target: "config",
      windows: [],
    };
  }

  if (mode === "always") {
    return {
      fast: true,
      rule: "always",
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

  return inspectFast(usage, bias, previous, age);
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

function withPriority(parsed: JsonBody | undefined, mode: FastMode) {
  if (!parsed || parsed.tier || mode === "disabled") return undefined;
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

function guardScore(win: RankWindow, age = 0): GuardView | null {
  if (!win.ready) return null;
  const used = clamp(win.ready.used_percent, 0, 100);
  const left = 1 - used / 100;
  const floor = left < FAST_MIN_LEFT ? left / FAST_MIN_LEFT : 1;
  const hit = normalized(win.ready, 1, age);
  return {
    label: win.label,
    name: win.name,
    ready: win.ready,
    floor,
    score: hit?.score ?? 0,
  } satisfies GuardView;
}

function reduceScore(list: RankWindow[], age = 0): ScoreHit | null {
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
    const next = guardScore(item, age);
    if (!next) return worst;

    const weight = guardWeight(main.ready, next.ready, age);
    const pace = Math.min(1, Math.exp(weight * next.score));
    const factor = Math.min(next.floor, pace);
    const hit = {
      label: next.label,
      name: next.name,
      factor,
      score: next.score,
      weight,
    } satisfies ScoreGuard;

    if (!worst) return hit;
    return hit.factor < worst.factor ? hit : worst;
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

function limitScore(
  label: string,
  limit: Limit | undefined,
  plan: number,
  age = 0,
): ScoreHit | null {
  if (!limit) return null;
  if (blocked(limit)) return { score: 0, blockedFor: blockedFor(limit, age), label, windows: [] };

  const list = dedupeWindows(
    [
      rankWindow(`${label}.primary`, limit.primary_window, plan),
      rankWindow(`${label}.secondary`, limit.secondary_window, plan),
    ].filter(
      (item): item is RankWindow => item !== null,
    ),
  );

  if (list.length === 0) return null;

  const reduced = reduceScore(list, age);
  if (reduced) return reduced;

  const best = list.reduce((win, item) => (item.score < win.score ? item : win));
  return {
    score: best.score,
    label: best.label,
    windows: list,
  };
}

function score(body: Usage, age = 0): ScoreHit | null {
  const plan = weight(body.plan_type);
  const list = [limitScore("rate", body.rate_limit, plan, age)];

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
  return usageView(store, row);
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
      if (row.chatgpt_account_id) {
        headers.set("ChatGPT-Account-Id", row.chatgpt_account_id);
      }

      const res = await fetch(CODEX_USAGE_ENDPOINT, { headers });
      if (!res.ok) return null;
      const usage = ((await res.json()) as Usage) ?? {};
      store.cacheUsage(row.id, usage);
      if (usage.account_id && usage.account_id !== row.chatgpt_account_id) {
        store.updateChatGPTAccountId(row.id, usage.account_id);
      }
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
  usage: UsageView,
  mode: FastMode,
  bias: number,
  previous?: boolean,
) : AttemptResult {
  const body = usage.body ?? null;
  const info = explainFast(input, parsed, body, mode, bias, previous, cacheAge(usage.at));
  const url = rewrite(input).toString();
  if (url !== CODEX_API_ENDPOINT) {
    return { init, fast: false, note: fastNote(info) };
  }
  const next = withPriority(parsed, mode);
  if (!next) return { init, fast: false, note: fastNote(info) };
  if (!info.fast) {
    return { init, fast: false, note: fastNote(info) };
  }
  if (info.rule !== "always" && !body) {
    return { init, fast: false, note: fastNote(info) };
  }
  return {
    init: {
      ...init,
      body: new TextEncoder().encode(JSON.stringify(next)).buffer,
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
            .filter((row) => seen.has(row.id))
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
  config: PoolConfig,
  warm = true,
): RankResult {
  const sticky = active(affinity, config.stickyMode);
  if (rows.length <= 1) {
    return {
      rows,
      scores: rows.map((row) => quota(store, row, config, sticky)),
      reason: rows.length === 1 ? "only available account" : undefined,
    };
  }

  if (!store.primary() && rows.every((row) => row.primary !== 1)) {
    return {
      rows,
      scores: rows.map((row) => quota(store, row, config, sticky)),
    };
  }

  const list = rows.map((row) => quota(store, row, config, sticky, warm));
  if (list.some((item) => item.score === undefined)) {
    return {
      rows,
      scores: list,
      reason: "quota cache warming",
    };
  }

  const preferred = list.filter((item) => item.touches.length > 0);
  if (preferred.length > 0) {
    const scores = new Map(preferred.map((item) => [item.id, item.score ?? 0]));
    const touches = new Map(preferred.map((item) => [item.id, touchScore(item.touches)]));
    const picked = rows.filter((row) => preferred.some((item) => item.id === row.id));
    const ranked = orderTouches(picked, scores, touches);
    const top = ranked[0];
    const detail = preferred.find((item) => item.id === top?.id);
    return {
      rows: ranked,
      scores: list,
      reason: touchReason(detail?.touches ?? []),
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

  if (sticky) {
    const stick = rows.find((row) => row.id === affinity.id);
    const base = stick ? scores.get(stick.id) ?? 0 : 0;
    const alt = stick ? ordered.find((row) => row.id !== stick.id) : undefined;
    const best = alt ? scores.get(alt.id) ?? 0 : 0;

    if (stick && alt && base > 0) {
      if (
        config.stickyMode !== "always" &&
        best > base * (1 + margin(base, best, config.stickyStrength))
      ) {
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
  config: PoolConfig = DEFAULT_CONFIG,
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
    const candidate = withPriority(parsed, config.fastMode);

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
    const ranked = rank(store, rows, affinity, config, !prefetched);
    const ordered = ranked.rows;
    const list =
      ordered.length > 0
        ? ordered
        : [pick(store)].filter((row) => row !== undefined);

    if (
      config.fastMode === "auto" &&
      candidate &&
      rewrite(input).toString() === CODEX_API_ENDPOINT &&
      list.length === 1
    ) {
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
        let usage = cachedUsage(store, row);
        const sticky = active(affinity, config.stickyMode);
        const current = quota(store, row, config, sticky);
        let used = attempt(
          input,
          snap,
          parsed,
          usage,
          config.fastMode,
          config.fastModeBias,
          sticky && affinity.id === row.id ? affinity.fast : undefined,
        );
        if (!sticky || affinity.id !== row.id) {
          const scores = listed(
            ranked.scores.length > 0 ? ranked.scores : [quota(store, row, config, sticky)],
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
          usage = cachedUsage(store, row);
          used = attempt(
            input,
            snap,
            parsed,
            usage,
            config.fastMode,
            config.fastModeBias,
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
          rememberTouches(store, row.id, usage.body, config.dormantTouch);
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
