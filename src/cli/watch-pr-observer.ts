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
  active: AbortController | null;
  closed: boolean;
}

async function readPr(
  state: ObserverState,
  attempt: { readonly entry: Entry; readonly controller: AbortController },
): Promise<PrObservation> {
  const { entry, controller } = attempt;
  const deadline = { expired: false };
  const timeout: PrObservation = { status: "unavailable", failure: "timeout" };
  const cancel = state.clock.after(() => {
    deadline.expired = true;
    entry.result = timeout;
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
    return deadline.expired ? timeout : prCommandResult(entry.identity, output);
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
  const entry = state.queue.shift();
  if (entry === undefined) return;
  const controller = new AbortController();
  state.active = controller;
  entry.started = state.clock.now();
  const completed = (result: PrObservation): void => {
    entry.result = result;
    entry.pending = false;
    state.active = null;
    pump(state);
  };
  readPr(state, { entry, controller }).then(completed, () => {
    completed({ status: "unavailable", failure: "command" });
  });
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
      return known?.result ?? null;
    const entry: Entry = {
      identity,
      result: known?.result ?? null,
      started: Infinity,
      pending: true,
    };
    state.cache.set(key, entry);
    state.queue.push(entry);
    pump(state);
    return entry.result;
  };
  return {
    observe,
    close: () => {
      state.closed = true;
      state.queue.length = 0;
      state.active?.abort();
    },
  };
}
