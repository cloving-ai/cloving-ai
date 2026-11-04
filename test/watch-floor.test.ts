import assert from "node:assert/strict";
import { test } from "node:test";
import type { WatchModel, WatchStation } from "../src/cli/watch-render.ts";
import { mergeRepository } from "./watch-merge-fixture.ts";
import { floorModel, floorRun, minutesBefore } from "./watch-floor-fixture.ts";

function line(model: WatchModel, workflowId: string): readonly WatchStation[] {
  return (
    model.workflows.find((workflow) => workflow.workflowId === workflowId)
      ?.stations ?? []
  );
}

function station(model: WatchModel, name: string): WatchStation | undefined {
  return line(model, "develop-issue").find((item) => item.name === name);
}

const decision = (runId: string) => ({
  runId,
  decisionId: `${runId}/review-1`,
  type: "approval",
  prompt: "Approve the work.",
  revision: 1,
  generation: 1,
  subjectDigest: "a".repeat(64),
});

await test("CLV-286 each workflow has its declared stages as stations in order", () => {
  const model = floorModel([], {
    workflows: ["develop-issue", "idea", "plain"],
  });
  assert.deepEqual(
    model.workflows.map((workflow) => [
      workflow.workflowId,
      workflow.stations.map((item) => [item.name, item.lamp, item.tokens]),
    ]),
    [
      [
        "develop-issue",
        ["Work tree", "Agent turn", "Pull request", "Code review", "Merge"].map(
          (name) => [name, null, []],
        ),
      ],
      ["idea", ["Draft", "Review"].map((name) => [name, null, []])],
      ["plain", ["Agent turn", "Your review"].map((name) => [name, null, []])],
    ],
  );
});

await test("CLV-286 a lamp shows the most urgent state: stopped, then needs you, then waiting, then running", () => {
  const at = (runId: string, options: Parameters<typeof floorRun>[1]) =>
    floorRun(runId, { operation: "github-open-pr", minutes: 5, ...options });
  const model = (runs: readonly unknown[], runIds: readonly string[] = []) =>
    floorModel(runs, { decisions: runIds.map(decision) });
  const running = at("running", {});
  const stopped = at("stopped", { state: "paused" });
  const person = at("person", { state: "waiting_gate" });
  const waiting = at("waiting", { awaitedRunId: "running" });
  const queued = at("queued", { state: "queued" });
  const lamps = (shown: WatchModel) => {
    const item = station(shown, "Pull request");
    return [item?.lamp, item?.tokens.map((token) => token.lamp)];
  };
  assert.deepEqual(lamps(model([running, stopped])), [
    "stopped",
    ["stopped", "running"],
  ]);
  assert.deepEqual(lamps(model([running, waiting, person], ["person"])), [
    "needs-you",
    ["needs-you", "waiting", "running"],
  ]);
  assert.deepEqual(lamps(model([running, queued])), [
    "waiting",
    ["waiting", "running"],
  ]);
  const command = at("command", {
    commandWaits: [
      {
        name: "ci",
        command: "check-ci",
        state: "waiting",
        maximumWaitSeconds: 600,
        remainingSeconds: 300,
        checkCount: 1,
      },
    ],
  });
  assert.deepEqual(lamps(model([running, command])), [
    "waiting",
    ["waiting", "running"],
  ]);
  assert.deepEqual(lamps(model([running])), ["running", ["running"]]);
  assert.equal(station(model([running]), "Merge")?.lamp, null);
  const decided = model([at("decided", {})], ["decided"]);
  assert.equal(station(decided, "Pull request")?.lamp, "needs-you");
});

await test("CLV-286 a token shows the worker initial, the ticket number and the start of the step", () => {
  const model = floorModel(
    [
      floorRun("claude", {
        operation: "claude-turn",
        minutes: 38,
        ticketId: "583",
        harness: "claude",
      }),
      floorRun("grok", {
        operation: "claude-turn",
        minutes: 6,
        ticketId: "DEMO-4",
        harness: "grok",
      }),
      floorRun("person", {
        operation: "claude-turn",
        minutes: 3,
        state: "waiting_gate",
        harness: "claude",
      }),
      floorRun("unknown", { operation: "claude-turn", minutes: 1 }),
      floorRun("issue", {
        operation: "claude-turn",
        minutes: 2,
        ticketId: "CLV-7",
        issueIdentity: { owner: "fixture", repository: "demo", number: 7 },
      }),
    ],
    { decisions: [decision("person")], repository: mergeRepository },
  );
  assert.deepEqual(
    station(model, "Agent turn")?.tokens.map((token) => [
      token.runId,
      token.worker,
      token.ticket,
      token.startedAt,
    ]),
    [
      ["person", "Y", "Draft", minutesBefore(3)],
      ["claude", "C", "#583", minutesBefore(38)],
      ["grok", "G", "DEMO-4", minutesBefore(6)],
      ["issue", "·", "#7", minutesBefore(2)],
      ["unknown", "·", "Draft", minutesBefore(1)],
    ],
  );
});

await test("CLV-286 a run at a step outside the declared stages gets a station after the last stage", () => {
  const model = floorModel([
    floorRun("other", { operation: "unmatched", minutes: 4 }),
    floorRun("first-unstarted", {}),
    floorRun("second-unstarted", {}),
    floorRun("done", { state: "completed", operation: "github-merge" }),
  ]);
  assert.deepEqual(
    line(model, "develop-issue").map((item) => [item.name, item.tokens.length]),
    [
      ["Work tree", 0],
      ["Agent turn", 0],
      ["Pull request", 0],
      ["Code review", 0],
      ["Merge", 0],
      ["Other", 3],
    ],
  );
  assert.deepEqual(
    line(model, "develop-issue")
      .at(-1)
      ?.tokens.map((token) => [token.runId, token.startedAt]),
    [
      ["other", minutesBefore(4)],
      ["first-unstarted", null],
      ["second-unstarted", null],
    ],
  );
});

await test("CLV-286 the queued workflow line gets the ready count and the oldest ready time of the queue", () => {
  const ready = (value: unknown) =>
    floorModel([], {
      queue: { workflowId: "develop-issue", lanes: 2, busy: 0, ready: value },
    }).workflows.map((workflow) => [workflow.workflowId, workflow.ready]);
  assert.deepEqual(ready({ count: 3, oldestAt: minutesBefore(125) }), [
    ["develop-issue", { count: 3, oldestAt: minutesBefore(125) }],
    ["idea", undefined],
  ]);
  assert.deepEqual(ready({ count: 0, oldestAt: null }), [
    ["develop-issue", { count: 0, oldestAt: null }],
    ["idea", undefined],
  ]);
  assert.deepEqual(ready({ failure: "The command failed." }), [
    ["develop-issue", { failure: "The command failed." }],
    ["idea", undefined],
  ]);
  for (const value of [undefined, { count: -1, oldestAt: null }, { count: 2 }])
    assert.deepEqual(ready(value), [
      ["develop-issue", undefined],
      ["idea", undefined],
    ]);
});
