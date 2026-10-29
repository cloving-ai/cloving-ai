import assert from "node:assert/strict";
import { fakeStepBridge } from "cloving/workflows/testing";
import { develop } from "../develop.ts";
import { commit, input, completed, effects } from "./scenarios.ts";

export interface FlowTest {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}
export const flowTests: FlowTest[] = [];

flowTests.push({
  name: "CLV-221 a worker error blocks the ticket before propagating",
  run: async () => {
    using bridge = fakeStepBridge({
      effects: {
        ...effects(),
        "claude run-turn": [
          {
            kind: "failed",
            operationId: "failed-operation",
            reason: "worker-failed",
          },
        ],
      },
    });
    await assert.rejects(develop(input), { message: "worker-failed" });
    assert.equal(
      bridge.requests.filter(
        (request) => request[0] === "effect" && request[1].method === "label",
      ).length,
      2,
    );
    const last = bridge.requests.at(-1);
    assert.ok(last && last[0] === "effect");
    assert.match(last[1].payload, /cloving: blocked/);
  },
});

flowTests.push({
  name: "CLV-221 a terminal merge failure moves the selected ticket out of the queue",
  run: async () => {
    using bridge = fakeStepBridge({
      effects: {
        ...effects(),
        "github merge": [
          completed({ reason: "ci-pending", output: "Waiting for CI." }),
        ],
      },
    });
    assert.equal((await develop(input)).kind, "blocked");
    const labels = bridge.requests.filter(
      (request) => request[0] === "effect" && request[1].method === "label",
    );
    assert.equal(labels.length, 2);
    assert.deepEqual(
      labels.map((request) => {
        assert.ok(request[0] === "effect");
        return {
          scope: request[1].scope,
          payload: JSON.parse(request[1].payload) as unknown,
        };
      }),
      [
        {
          scope: {
            phase: "pull-request",
            operation: "github-label",
            round: 1,
            key: "start",
          },
          payload: {
            owner: "acme",
            repository: "demo",
            number: 42,
            add: ["cloving: in progress"],
            remove: ["cloving: ready", "cloving: blocked"],
          },
        },
        {
          scope: {
            phase: "pull-request",
            operation: "github-label",
            round: 1,
            key: "blocked",
          },
          payload: {
            owner: "acme",
            repository: "demo",
            number: 42,
            add: ["cloving: blocked"],
            remove: ["cloving: in progress"],
          },
        },
      ],
    );
  },
});

flowTests.push({
  name: "CLV-221 private worker diagnostics stay out of the public pull request",
  run: async () => {
    using bridge = fakeStepBridge({
      effects: {
        ...effects(),
        "claude run-turn": [
          completed({
            summary:
              "Internal diagnostics: private-check-output\nTicket status: complete",
          }),
        ],
      },
    });
    await develop(input);
    const opened = bridge.requests.find(
      (request) => request[0] === "effect" && request[1].method === "open-pr",
    );
    assert.ok(opened && opened[0] === "effect");
    assert.doesNotMatch(opened[1].payload, /private-check-output/);
  },
});

flowTests.push({
  name: "CLV-221 the default workflow merges only a reviewed pull after the checks",
  run: async () => {
    using bridge = fakeStepBridge({ effects: effects(), effectLimit: 27 });
    assert.deepEqual(await develop(input), {
      kind: "handoff_requested",
      cycleId: input.cycleId,
      promotionId: "pull-request-7",
      ticketStatus: "complete",
    });
    assert.deepEqual(
      bridge.requests.map((request) => {
        assert.ok(request[0] === "effect");
        return request[1].method;
      }),
      [
        "prepare",
        "label",
        "run-turn",
        "open-pr",
        "wait-review",
        "merge",
        "close-issue",
      ],
    );
    const merge = bridge.requests[5];
    assert.ok(merge && merge[0] === "effect");
    assert.deepEqual(JSON.parse(merge[1].payload), {
      number: 7,
      commit,
      check: "beforeMerge",
    });
  },
});

for (const reason of ["check-failed", "merge-conflict", "ci-failed"]) {
  flowTests.push({
    name: `CLV-221 a ${reason} fix receives the merge output and is reviewed again`,
    run: async () => {
      const scenario = effects();
      const output =
        "First diagnostic\n  expected: 4\n  actual: 3\nLast diagnostic\n";
      for (const key of [
        "claude run-turn",
        "github open-pr",
        "github wait-review",
      ] as const)
        scenario[key] = [...scenario[key], ...scenario[key]];
      scenario["github merge"] = [
        completed({ reason, output }),
        ...scenario["github merge"],
      ];
      using bridge = fakeStepBridge({ effects: scenario });
      assert.equal((await develop(input)).kind, "handoff_requested");
      const turns = bridge.requests.filter(
        (request) =>
          request[0] === "effect" && request[1].method === "run-turn",
      );
      assert.equal(turns.length, 2);
      const fix = turns[1];
      assert.ok(fix && fix[0] === "effect");
      assert.ok(fix[1].payload.endsWith(output));
      assert.ok(fix[1].payload.includes(reason));
      const merges = bridge.requests.filter(
        (request) => request[0] === "effect" && request[1].method === "merge",
      );
      assert.deepEqual(
        merges.map((request) => {
          assert.ok(request[0] === "effect");
          return request[1].scope.round;
        }),
        [1, 2],
      );
      assert.equal(
        bridge.requests.filter(
          (request) =>
            request[0] === "effect" && request[1].method === "wait-review",
        ).length,
        2,
      );
    },
  });
}

flowTests.push({
  name: "CLV-221 Greptile below 5/5 cannot merge and exhausts three review fixes",
  run: async () => {
    const scenario = effects();
    for (const key of ["claude run-turn", "github open-pr"] as const)
      scenario[key] = Array.from({ length: 4 }, () => scenario[key][0]).filter(
        (value) => value !== undefined,
      );
    scenario["github wait-review"] = Array.from({ length: 4 }, () =>
      completed({
        number: 7,
        commit,
        score: 4,
        summary: "Add recovery.",
        findings: [],
      }),
    );
    using bridge = fakeStepBridge({ effects: scenario });
    assert.deepEqual(await develop(input), {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "review-changes",
      evidenceId: "review",
    });
    assert.equal(
      bridge.requests.filter(
        (request) =>
          request[0] === "effect" && request[1].method === "run-turn",
      ).length,
      4,
    );
    assert.equal(
      bridge.requests.some(
        (request) => request[0] === "effect" && request[1].method === "merge",
      ),
      false,
    );
  },
});

for (const [reason, merge] of [
  [
    "ci-pending",
    completed({ reason: "ci-pending", output: "Check prerequisites." }),
  ],
  [
    "check-not-configured",
    {
      kind: "failed",
      operationId: "failed-operation",
      reason: "check-not-configured",
    },
  ],
] as const) {
  flowTests.push({
    name: `CLV-221 ${reason} stops without another worker turn`,
    run: async () => {
      using bridge = fakeStepBridge({
        effects: { ...effects(), "github merge": [merge] },
      });
      assert.equal((await develop(input)).kind, "blocked");
      assert.equal(bridge.requests.length, 7);
    },
  });
}

flowTests.push({
  name: "CLV-221 a merged issue update failure stays visible",
  run: async () => {
    using bridge = fakeStepBridge({
      effects: {
        ...effects(),
        "github close-issue": [
          {
            kind: "failed",
            operationId: "failed-operation",
            reason: "offline",
          },
        ],
      },
    });
    assert.deepEqual(await develop(input), {
      kind: "handoff_requested",
      cycleId: input.cycleId,
      promotionId: "pull-request-7",
      ticketStatus: "complete",
      issueUpdate: "failed",
    });
    assert.equal(bridge.requests.length, 7);
  },
});

flowTests.push({
  name: "CLV-221 a non-GitHub ticket needs no issue update",
  run: async () => {
    using bridge = fakeStepBridge({ effects: effects() });
    assert.equal(
      (
        await develop({
          ...input,
          input: { ticket: { id: "42", text: "Fix the counter." } },
        })
      ).kind,
      "handoff_requested",
    );
    assert.equal(bridge.requests.length, 5);
  },
});

flowTests.push({
  name: "CLV-221 broker failure stops before the worker runs",
  run: async () => {
    using bridge = fakeStepBridge({ effectLimit: 0 });
    await assert.rejects(develop(input), { message: "budget-exhausted" });
    assert.equal(bridge.requests.length, 1);
  },
});

flowTests.push({
  name: "CLV-221 partial work is queued only after its reviewed pull merges",
  run: async () => {
    const scenario = effects();
    scenario["claude run-turn"] = [
      completed({
        summary: "Remaining:\n- Add recovery.\nTicket status: partial",
      }),
    ];
    using bridge = fakeStepBridge({
      effects: {
        ...scenario,
        "github partial-issue": [completed({ ticketStatus: "partial" })],
      },
    });
    assert.deepEqual(await develop(input), {
      kind: "handoff_requested",
      cycleId: input.cycleId,
      promotionId: "pull-request-7",
      ticketStatus: "partial",
    });
    const request = bridge.requests.at(-1);
    assert.ok(request && request[0] === "effect");
    assert.equal(request[1].method, "partial-issue");
    assert.deepEqual(JSON.parse(request[1].payload), {
      owner: "acme",
      repository: "demo",
      number: 42,
      pullRequest: 7,
      remaining: ["Add recovery."],
    });
  },
});

flowTests.push({
  name: "the develop turns keep fail-closed checks and operator steps out of the remaining list",
  run: async () => {
    const scenario = effects();
    for (const key of [
      "claude run-turn",
      "github open-pr",
      "github wait-review",
    ] as const)
      scenario[key] = [...scenario[key], ...scenario[key]];
    scenario["github merge"] = [
      completed({ reason: "check-failed", output: "Check output.\n" }),
      ...scenario["github merge"],
    ];
    using bridge = fakeStepBridge({ effects: scenario });
    await develop(input);
    const payloads = bridge.requests.flatMap((request) =>
      request[0] === "effect" && request[1].method === "run-turn"
        ? [request[1].payload]
        : [],
    );
    for (const sentence of [
      "List as remaining only work that the task asks for.",
      "A check that the repository keeps fail-closed on purpose is not remaining work.",
      "A step that the task gives to the operator is not remaining work.",
    ])
      assert.ok(payloads[0]?.includes(sentence), sentence);
    assert.ok(
      payloads[1]?.includes("Drop an item that the task does not ask for"),
    );
  },
});
