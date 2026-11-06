import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fakeStepBridge } from "cloving/workflows/testing";
import { develop } from "../develop.ts";
import { commit, completed, input } from "./scenarios.ts";
import type { FlowTest } from "./flow-tests.ts";
import {
  answered,
  calls,
  checkFailed,
  editable,
  failingRounds,
  failure,
  retried,
} from "./recovery-scenarios.ts";
import { decisionTests } from "./decision-tests.ts";

export const recoveryTests: FlowTest[] = [];

recoveryTests.push({
  name: "CLV-300 a short open-pr failure opens the pull request again without a new turn",
  run: async () => {
    const scenario = editable();
    scenario["github open-pr"] = [
      failure("git-call-failed"),
      completed({ number: 7, url: "pull/7", commit }),
    ];
    using bridge = fakeStepBridge({ effects: scenario });
    assert.deepEqual(await develop(input), {
      kind: "handoff_requested",
      cycleId: input.cycleId,
      promotionId: "pull-request-7",
      ticketStatus: "complete",
    });
    assert.deepEqual(calls(bridge.requests), [
      "prepare",
      "label",
      "run-turn",
      "open-pr",
      "sleep 60",
      "open-pr",
      "wait-review",
      "merge",
      "close-issue",
    ]);
    const opened = bridge.requests.flatMap((request) =>
      request[0] === "effect" && request[1].method === "open-pr"
        ? [request[1]]
        : [],
    );
    assert.deepEqual(
      opened.map((request) => request.scope),
      [
        { phase: "pull-request", operation: "github-open-pr", round: 1 },
        {
          phase: "pull-request",
          operation: "github-open-pr",
          round: 1,
          key: "retry-1",
        },
      ],
    );
    assert.equal(opened[1]?.payload, opened[0]?.payload);
  },
});

recoveryTests.push({
  name: "CLV-300 four short open-pr failures block the run with the last reason",
  run: async () => {
    const scenario = editable();
    scenario["github open-pr"] = [
      failure("git-call-failed"),
      failure("github-network-failed"),
      failure("git-call-failed"),
      failure("git-network-failed"),
    ];
    using bridge = fakeStepBridge({ effects: scenario });
    assert.deepEqual(await develop(input), {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "git-network-failed",
      evidenceId: "pull-request",
    });
    assert.deepEqual(calls(bridge.requests), [
      "prepare",
      "label",
      "run-turn",
      "open-pr",
      "sleep 60",
      "open-pr",
      "sleep 300",
      "open-pr",
      "sleep 900",
      "open-pr",
      "label",
    ]);
    const last = bridge.requests.at(-1);
    assert.ok(last && last[0] === "effect");
    assert.match(last[1].payload, /"add":\["cloving: blocked"\]/);
  },
});

recoveryTests.push({
  name: "CLV-300 a short merge failure merges the same commit again without a new turn",
  run: async () => {
    const scenario = editable();
    scenario["github merge"] = [
      failure("git-network-failed"),
      ...scenario["github merge"],
    ];
    using bridge = fakeStepBridge({ effects: scenario });
    assert.equal((await develop(input)).kind, "handoff_requested");
    assert.deepEqual(calls(bridge.requests), [
      "prepare",
      "label",
      "run-turn",
      "open-pr",
      "wait-review",
      "merge",
      "sleep 60",
      "merge",
      "close-issue",
    ]);
    const merges = bridge.requests.flatMap((request) =>
      request[0] === "effect" && request[1].method === "merge"
        ? [request[1]]
        : [],
    );
    assert.deepEqual(
      merges.map((request) => [request.scope.round, request.scope.key]),
      [
        [1, `7:${commit}`],
        [1, `7:${commit}:retry-1`],
      ],
    );
    assert.equal(merges[1]?.payload, merges[0]?.payload);
  },
});

recoveryTests.push({
  name: "CLV-300 four short merge failures block the run with the reason and the pull request link",
  run: async () => {
    const scenario = editable();
    scenario["github merge"] = [
      failure("git-network-failed"),
      failure("github-network-failed"),
      failure("git-network-failed"),
      failure("git-call-failed"),
    ];
    using bridge = fakeStepBridge({ effects: scenario });
    assert.deepEqual(await develop(input), {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "git-call-failed: pull/7",
      evidenceId: "merge",
    });
    assert.deepEqual(calls(bridge.requests).slice(5), [
      "merge",
      "sleep 60",
      "merge",
      "sleep 300",
      "merge",
      "sleep 900",
      "merge",
      "label",
    ]);
    assert.equal(
      calls(bridge.requests).filter((name) => name === "run-turn").length,
      1,
    );
  },
});

recoveryTests.push({
  name: "CLV-300 a short label failure labels the ticket again before the turn",
  run: async () => {
    const scenario = editable();
    scenario["github label"] = [
      failure("github-network-failed"),
      ...scenario["github label"],
    ];
    using bridge = fakeStepBridge({ effects: scenario });
    assert.equal((await develop(input)).kind, "handoff_requested");
    assert.deepEqual(calls(bridge.requests).slice(0, 5), [
      "prepare",
      "label",
      "sleep 60",
      "label",
      "run-turn",
    ]);
    const labels = bridge.requests.flatMap((request) =>
      request[0] === "effect" && request[1].method === "label"
        ? [request[1]]
        : [],
    );
    assert.deepEqual(
      labels.map((request) => request.scope.key),
      ["start", "start:retry-1"],
    );
    assert.equal(labels[1]?.payload, labels[0]?.payload);
  },
});

recoveryTests.push({
  name: "CLV-300 four short start label failures block the run before the turn",
  run: async () => {
    const scenario = editable();
    scenario["github label"] = [
      failure("github-network-failed"),
      failure("github-network-failed"),
      failure("github-network-failed"),
      failure("git-network-failed"),
    ];
    using bridge = fakeStepBridge({ effects: scenario });
    assert.deepEqual(await develop(input), {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "git-network-failed",
      evidenceId: "label",
    });
    assert.deepEqual(calls(bridge.requests), [
      "prepare",
      "label",
      "sleep 60",
      "label",
      "sleep 300",
      "label",
      "sleep 900",
      "label",
    ]);
  },
});

recoveryTests.push({
  name: "CLV-300 a blocked run keeps its reason when its blocked label fails four times",
  run: async () => {
    const scenario = editable();
    scenario["github merge"] = [
      completed({ reason: "ci-pending", output: "Waiting for CI." }),
    ];
    scenario["github label"] = [
      completed({}),
      ...Array.from({ length: 4 }, () => failure("github-network-failed")),
    ];
    using bridge = fakeStepBridge({ effects: scenario });
    assert.deepEqual(await develop(input), {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "ci-pending",
      evidenceId: "merge",
    });
    assert.deepEqual(
      calls(bridge.requests).filter((name) => name === "label").length,
      5,
    );
  },
});

recoveryTests.push({
  name: "CLV-300 the longest recovery stays within the declared effect limit",
  run: async () => {
    const declaration: unknown = JSON.parse(
      await readFile(
        new URL("../develop.declaration.json", import.meta.url),
        "utf8",
      ),
    );
    const limit = Number(
      Reflect.get(
        Object(Reflect.get(Object(declaration), "workflow")),
        "effectLimit",
      ),
    );
    const scenario = failingRounds(
      Array.from({ length: 6 }, () => checkFailed),
    );
    const rounds = Array.from({ length: 6 });
    using bridge = fakeStepBridge({
      effects: {
        ...scenario,
        "github label": [...retried(completed({})), ...retried(completed({}))],
        "claude run-turn": rounds.flatMap(() => [
          failure("claude-turn-interrupted"),
          ...scenario["claude run-turn"].slice(0, 1),
        ]),
        "github open-pr": rounds.flatMap(() =>
          retried(completed({ number: 7, url: "pull/7", commit })),
        ),
        "github merge": rounds.flatMap(() => retried(checkFailed)),
        "github close-pr": [completed({ number: 7, closed: true })],
      },
      decisions: [answered("1"), answered("3")],
      effectLimit: limit,
    });
    assert.deepEqual(await develop(input), {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "pull-request-closed: pull/7",
      evidenceId: "merge",
    });
    assert.equal(bridge.spent, 76);
    assert.ok(bridge.spent <= limit);
    assert.equal(limit, 87);
  },
});

recoveryTests.push(...decisionTests);
