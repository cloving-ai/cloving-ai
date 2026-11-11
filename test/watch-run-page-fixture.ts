import assert from "node:assert/strict";
import { component } from "../src/cli/watch-element.ts";
import type { WatchModel, WatchRun } from "../src/cli/watch-render.ts";
import type { RunCommandControls } from "../src/cli/watch-run-command-view.ts";
import type { SteerControls } from "../src/cli/watch-steer-view.ts";
import type { RenameControls } from "../src/cli/watch-rename-view.ts";
import { Page } from "../src/cli/watch-view.ts";
import { renameControls } from "./watch-rename-fixture.ts";
import {
  at,
  noCopy,
  phases,
  sampleModel,
  sampleRun,
  sampleTurn,
} from "./watch-sample.ts";

export const quiet =
  "No observation arrived in the liveness period. Silence alone is not a failure.";

export const working = sampleRun({
  runId: "run-7",
  state: "running",
  code: "no-recent-observation",
  detail: quiet,
  decisions: [],
  label: "#726",
  title: "Find commit signatures",
  phases: phases(["done", "done", "active"]),
  turns: [
    sampleTurn({ activity: [{ kind: "say", text: "I run the tests." }] }),
  ],
  pullRequest: {
    number: 732,
    url: "https://github.com/cloving-ai/cloving-ai/pull/732",
  },
  reviews: [
    { round: 1, score: 4, commit: "0ff2f41aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { round: 2, score: 3, commit: "ca90684aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  ],
  claudeCostUsd: 9.24,
  chain: { position: 1, limit: 5 },
});

export const bare = sampleRun({
  runId: "run-8",
  state: "running",
  code: "run-running",
  detail: "The run is in work.",
  decisions: [],
  turns: [],
  claudeCostUsd: null,
  phases: phases(["done", "done", "active"]),
});

export const ended = { ...working, runId: "run-9", state: "completed" };

export function model(): WatchModel {
  return {
    ...sampleModel([working, bare, ended]),
    queue: {
      state: "running",
      busy: 1,
      lanes: 3,
      skipped: [{ ticketId: "234", reason: "ticket-active" }],
    },
  };
}

export interface Controls {
  readonly renaming?: RenameControls;
  readonly controlling?: RunCommandControls;
  readonly steering?: SteerControls;
}

export function page(run: WatchRun, controls: Controls = {}) {
  return component(Page, {
    model: model(),
    selected: `run=${run.runId}`,
    now: at("21:34:41"),
    stale: false,
    copying: noCopy,
    ...controls,
  });
}

export function commands(calls: string[]): RunCommandControls {
  return {
    busy: [],
    messages: {},
    asking: null,
    onCommand: (runId, command) => calls.push(`${command} ${runId}`),
    onAsk: (runId, place) => calls.push(`ask ${runId} ${place}`),
    onKeep: () => calls.push("keep"),
  };
}

export function steers(
  calls: string[],
  changes: Partial<SteerControls> = {},
): SteerControls {
  return {
    open: null,
    note: "",
    now: false,
    busy: [],
    messages: {},
    onOpen: (runId) => calls.push(`steer ${runId}`),
    onClose: () => undefined,
    onNote: () => undefined,
    onNow: () => undefined,
    onSend: () => undefined,
    ...changes,
  };
}

export function all(calls: string[]): Controls {
  return {
    renaming: renameControls({
      opened: [],
      saved: [],
      cleared: [],
      closed: [],
    }),
    controlling: commands(calls),
    steering: steers(calls),
  };
}

export function banner(html: string): string {
  const start = html.indexOf('<section class="banner');
  return html.slice(start, html.indexOf("</section>", start));
}

export function click(
  node: Readonly<Record<string, unknown>> | undefined,
): void {
  const handler = node?.["onClick"];
  assert.ok(typeof handler === "function");
  Reflect.apply(handler, undefined, []);
}
