import assert from "node:assert/strict";
import { fakeStepBridge } from "cloving/workflows/testing";
import { docsDrift } from "../docs-drift.ts";
import {
  candidate,
  commit,
  completed,
  effects,
  input,
  methods,
  row,
  scan,
  turn,
} from "./scenarios.ts";

export interface RefusalTest {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export const refusalTests: RefusalTest[] = [];

const failed = {
  kind: "failed" as const,
  operationId: "c",
  reason: "command-exit",
};
const missing = {
  kind: "completed" as const,
  operationId: "c",
  receipt: null,
  result: null,
};
const one = [candidate("README.md")];

const candidateRefusals: readonly (readonly [unknown, string])[] = [
  [failed, "command-exit"],
  [missing, "invalid-docs-candidates"],
  [
    { kind: "completed", operationId: "c", receipt: null, result: "x" },
    "invalid-docs-candidates",
  ],
  [completed([]), "invalid-docs-candidates"],
  [
    completed(
      scan(
        Array.from({ length: 16 }, (_, index) =>
          candidate(`d${String(index)}.md`),
        ),
      ),
    ),
    "invalid-docs-candidates",
  ],
  [completed(scan([candidate("../outside.md")])), "invalid-docs-candidates"],
  [completed(scan([candidate("notes.txt")])), "invalid-docs-candidates"],
  [
    completed(scan([candidate("README.md"), candidate("README.md")])),
    "invalid-docs-candidates",
  ],
  [
    completed(scan([candidate("README.md", { since: "main" })])),
    "invalid-docs-candidates",
  ],
  [
    completed(scan([candidate("README.md", { code: [] })])),
    "invalid-docs-candidates",
  ],
  [
    completed(scan([candidate("README.md", { codeCount: 0 })])),
    "invalid-docs-candidates",
  ],
  [completed(scan(one, { commit: "abc" })), "invalid-docs-candidates"],
  [completed(scan(one, { more: -1 })), "invalid-docs-candidates"],
  [completed(scan(one, { branch: "-main" })), "invalid-docs-candidates"],
];

for (const [result, reason] of candidateRefusals)
  refusalTests.push({
    name: `CLV-317 the candidate result ${JSON.stringify(result).slice(0, 90)} blocks the run with ${reason} before the turn`,
    run: async () => {
      using bridge = fakeStepBridge({
        effects: Object.assign(effects(scan(one)), {
          "command run:docs-candidates": [result],
        }),
      });
      assert.deepEqual(await docsDrift(input), {
        kind: "blocked",
        cycleId: input.cycleId,
        evidenceId: "docs-drift",
        reason,
      });
      assert.deepEqual(methods(bridge.requests), ["run:docs-candidates"]);
    },
  });

const turnRefusals: readonly (readonly [unknown, string])[] = [
  [{ kind: "failed", operationId: "t", reason: "turn-failed" }, "turn-failed"],
  [completed({ summary: 7 }), "invalid-drift-result"],
  [completed({ summary: "not json" }), "invalid-drift-result"],
  [completed({ summary: "x".repeat(48001) }), "drift-result-too-large"],
  [turn({ docs: {} }), "invalid-drift-result"],
  [
    turn({ docs: [{ doc: "OTHER.md", rows: [row()] }] }),
    "invalid-drift-result",
  ],
  [
    turn({
      docs: [
        { doc: "README.md", rows: [] },
        { doc: "README.md", rows: [] },
      ],
    }),
    "invalid-drift-result",
  ],
  [
    turn({ docs: [{ doc: "README.md", rows: [row({ line: 0 })] }] }),
    "invalid-drift-result",
  ],
  [
    turn({ docs: [{ doc: "README.md", rows: [row({ says: " " })] }] }),
    "invalid-drift-result",
  ],
  [
    turn({ docs: [{ doc: "README.md", rows: "none" }] }),
    "invalid-drift-result",
  ],
  [
    turn({
      docs: [{ doc: "README.md", rows: [row({ fix: "x".repeat(601) })] }],
    }),
    "invalid-drift-result",
  ],
];

for (const [result, reason] of turnRefusals)
  refusalTests.push({
    name: `CLV-317 the turn result ${JSON.stringify(result).slice(0, 90)} blocks the run with ${reason} after the discard`,
    run: async () => {
      using bridge = fakeStepBridge({
        effects: Object.assign(effects(scan(one)), {
          "claude run-turn": [result],
        }),
      });
      assert.deepEqual(await docsDrift(input), {
        kind: "blocked",
        cycleId: input.cycleId,
        evidenceId: "docs-drift",
        reason,
      });
      assert.deepEqual(methods(bridge.requests), [
        "run:docs-candidates",
        "prepare",
        "run-turn",
        "discard",
      ]);
    },
  });

refusalTests.push({
  name: "CLV-317 a failed prepare blocks the run with no turn and no discard",
  run: async () => {
    using bridge = fakeStepBridge({
      effects: Object.assign(effects(scan(one)), {
        "github prepare": [
          {
            kind: "failed",
            operationId: "p",
            reason: "work-tree-not-available",
          },
        ],
      }),
    });
    const outcome = await docsDrift(input);
    assert.equal(
      outcome.kind === "blocked" ? outcome.reason : "",
      "work-tree-not-available",
    );
    assert.deepEqual(methods(bridge.requests), [
      "run:docs-candidates",
      "prepare",
    ]);
  },
});

const prepareRefusals: readonly (readonly [unknown, string])[] = [
  [
    completed({ worktree: "tree", base: "master", startCommit: commit }),
    "default-branch-mismatch",
  ],
  [completed({ worktree: "tree", base: "main" }), "invalid-prepare-result"],
  [
    completed({ worktree: "tree", base: "main", startCommit: "HEAD" }),
    "invalid-prepare-result",
  ],
  [
    { kind: "completed", operationId: "p", receipt: null, result: "x" },
    "invalid-prepare-result",
  ],
];

for (const [result, reason] of prepareRefusals)
  refusalTests.push({
    name: `CLV-317 the prepare result ${JSON.stringify(result).slice(0, 90)} blocks the run with ${reason} after the discard and before the turn`,
    run: async () => {
      using bridge = fakeStepBridge({
        effects: Object.assign(effects(scan(one)), {
          "github prepare": [result],
        }),
      });
      const outcome = await docsDrift(input);
      assert.equal(outcome.kind === "blocked" ? outcome.reason : "", reason);
      assert.deepEqual(methods(bridge.requests), [
        "run:docs-candidates",
        "prepare",
        "discard",
      ]);
    },
  });

refusalTests.push({
  name: "CLV-317 a prepare or discard with no result blocks the run",
  run: async () => {
    for (const [key, reason] of [
      ["github prepare", "missing-prepare-result"],
      ["github discard", "missing-discard-result"],
      ["command run:docs-drift-record", "missing-record-result"],
    ] as const) {
      using bridge = fakeStepBridge({
        effects: Object.assign(effects(scan(one)), { [key]: [missing] }),
      });
      const outcome = await docsDrift(input);
      assert.equal(outcome.kind === "blocked" ? outcome.reason : "", reason);
      assert.ok(bridge.requests.length > 1);
    }
  },
});

refusalTests.push({
  name: "CLV-317 a ticket above 48000 bytes blocks the run before the first handoff and the record",
  run: async () => {
    using bridge = fakeStepBridge({
      effects: effects(scan(one), {
        docs: [
          {
            doc: "README.md",
            rows: Array.from({ length: 30 }, (_, index) =>
              row({
                line: index + 1,
                says: "é".repeat(500),
                code: "é".repeat(500),
              }),
            ),
          },
        ],
      }),
    });
    const outcome = await docsDrift(input);
    assert.equal(
      outcome.kind === "blocked" ? outcome.reason : "",
      "drift-ticket-too-large",
    );
    assert.deepEqual(methods(bridge.requests), [
      "run:docs-candidates",
      "prepare",
      "run-turn",
      "discard",
    ]);
  },
});

refusalTests.push({
  name: "CLV-317 a failed record blocks the run after the handoffs",
  run: async () => {
    using bridge = fakeStepBridge({
      effects: Object.assign(
        effects(scan(one), { docs: [{ doc: "README.md", rows: [row()] }] }),
        { "command run:docs-drift-record": [failed] },
      ),
    });
    const outcome = await docsDrift(input);
    assert.equal(
      outcome.kind === "blocked" ? outcome.reason : "",
      "command-exit",
    );
    assert.deepEqual(methods(bridge.requests).slice(-2), [
      "handoff",
      "run:docs-drift-record",
    ]);
  },
});

refusalTests.push({
  name: "CLV-317 an error with a message that is not a code blocks the run with docs-drift-failed",
  run: async () => {
    using bridge = fakeStepBridge({
      effects: Object.assign(effects(scan(one)), {
        "command run:docs-candidates": [
          { kind: "failed", operationId: "c", reason: "Not A Code" },
        ],
      }),
    });
    const outcome = await docsDrift(input);
    assert.equal(
      outcome.kind === "blocked" ? outcome.reason : "",
      "docs-drift-failed",
    );
    assert.deepEqual(methods(bridge.requests), ["run:docs-candidates"]);
  },
});
