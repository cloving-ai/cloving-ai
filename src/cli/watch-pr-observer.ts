import type { WatchPullRequest } from "./watch-render.ts";
import {
  prArguments,
  prCommandResult,
  type WatchCommandRunner,
} from "./watch-pr-command.ts";
import {
  prIdentity,
  type PrIdentity,
  type PrObservation,
  type PrReadResult,
  type PrRepository,
} from "./watch-pr-identity.ts";

export interface PrObserver {
  readonly observe: (pullRequest: WatchPullRequest) => PrObservation | null;
  readonly close: () => void;
}

export interface PrClock {
  readonly now: () => number;
  readonly after: (expired: () => void, milliseconds: number) => () => void;
}

const systemClock: PrClock = {
  now: Date.now,
  after: (expired, milliseconds) => {
    const timer = setTimeout(expired, milliseconds);
    return () => {
      clearTimeout(timer);
    };
  },
};

export interface PrObserverSettings {
  readonly clock?: PrClock;
  readonly repository: PrRepository | null;
  readonly directory: string;
  readonly command: readonly string[] | null;
  readonly execute: WatchCommandRunner;
}

interface Entry {
  readonly identity: PrIdentity;
  result: PrObservation | null;
  started: number;
  pending: boolean;
}

interface ObserverState {
  readonly settings: PrObserverSettings;
  readonly clock: PrClock;
  readonly cache: Map<string, Entry>;
  readonly queue: Entry[];
  readonly retryDeadlines: Map<string, number>;
  wake: (() => void) | null;
  active: AbortController | null;
  closed: boolean;
}

function observationOf(
  entry: Entry,
  reply: { readonly result: PrReadResult; readonly now: number },
): PrObservation {
  const { result, now } = reply;
  if (result.status !== "unavailable")
    return { ...result, lastSuccess: { status: result.status, readAt: now } };
  const lastSuccess = entry.result?.lastSuccess;
  return { ...result, ...(lastSuccess === undefined ? {} : { lastSuccess }) };
}

async function readPr(
  state: ObserverState,
  attempt: { readonly entry: Entry; readonly controller: AbortController },
): Promise<PrReadResult> {
  const { entry, controller } = attempt;
  const deadline = { expired: false };
  const timeout: PrReadResult = { status: "unavailable", failure: "timeout" };
  const cancel = state.clock.after(() => {
    deadline.expired = true;
    entry.result = observationOf(entry, {
      result: timeout,
      now: state.clock.now(),
    });
    controller.abort();
  }, 5000);
  controller.signal.addEventListener("abort", cancel, { once: true });
  try {
    const output = await Promise.resolve().then(() =>
      state.settings.execute({
        command: [
          ...(state.settings.command ?? []),
          ...prArguments(entry.identity),
        ],
        directory: state.settings.directory,
        signal: controller.signal,
      }),
    );
    return deadline.expired
      ? timeout
      : prCommandResult(entry.identity, { output, now: state.clock.now() });
  } catch {
    return deadline.expired
      ? timeout
      : { status: "unavailable", failure: "command" };
  } finally {
    cancel();
    controller.signal.removeEventListener("abort", cancel);
  }
}

function pump(state: ObserverState): void {
  if (state.closed || state.active !== null) return;
  state.wake?.();
  state.wake = null;
  if (state.queue.length === 0) return;
  const now = state.clock.now();
  const position = state.queue.findIndex(
    (entry) => (state.retryDeadlines.get(entry.identity.host) ?? 0) <= now,
  );
  if (position === -1) {
    const next = Math.min(
      ...state.queue.map(
        (entry) => state.retryDeadlines.get(entry.identity.host) ?? now,
      ),
    );
    state.wake = state.clock.after(
      () => {
        state.wake = null;
        pump(state);
      },
      Math.min(next - now, 2147483647),
    );
    return;
  }
  const [entry] = state.queue.splice(position, 1);
  if (entry === undefined) return;
  const controller = new AbortController();
  state.active = controller;
  entry.started = state.clock.now();
  const completed = (result: PrReadResult): void => {
    if (state.closed) return;
    entry.result = observationOf(entry, { result, now: state.clock.now() });
    if (result.status === "unavailable" && result.failure === "rate-limit")
      state.retryDeadlines.set(
        entry.identity.host,
        Math.max(
          state.retryDeadlines.get(entry.identity.host) ?? 0,
          result.retryAt ?? state.clock.now() + 60000,
        ),
      );
    entry.pending = false;
    state.active = null;
    pump(state);
  };
  readPr(state, { entry, controller }).then(completed, () => {
    completed({ status: "unavailable", failure: "command" });
  });
}

function currentObservation(state: ObserverState, entry: Entry): PrObservation {
  const result = entry.result ?? { status: "pending" };
  const retryAt = state.retryDeadlines.get(entry.identity.host) ?? 0;
  return retryAt > state.clock.now() ? { ...result, retryAt } : result;
}

function needsRead(entry: Entry | undefined, now: number): boolean {
  if (entry === undefined) return true;
  if (entry.pending || entry.result?.status === "merged") return false;
  return now - entry.started >= 60000;
}

export function prObserver(settings: PrObserverSettings): PrObserver {
  const state: ObserverState = {
    settings,
    clock: settings.clock ?? systemClock,
    cache: new Map(),
    queue: [],
    retryDeadlines: new Map(),
    wake: null,
    active: null,
    closed: false,
  };
  const configured =
    settings.repository !== null && Boolean(settings.command?.[0]?.trim());
  const observe: PrObserver["observe"] = (pullRequest) => {
    if (!configured) return { status: "unavailable", failure: "configuration" };
    const identity = prIdentity(settings.repository, pullRequest);
    if (identity === null)
      return { status: "unavailable", failure: "identity" };
    const key = JSON.stringify(identity);
    const known = state.cache.get(key);
    if (state.closed || !needsRead(known, state.clock.now()))
      return known === undefined
        ? { status: "pending" }
        : currentObservation(state, known);
    const entry: Entry = {
      identity,
      result: known?.result ?? null,
      started: Infinity,
      pending: true,
    };
    state.cache.set(key, entry);
    state.queue.push(entry);
    pump(state);
    return currentObservation(state, entry);
  };
  return {
    observe,
    close: () => {
      state.closed = true;
      state.queue.length = 0;
      state.wake?.();
      state.wake = null;
      state.active?.abort();
    },
  };
}
