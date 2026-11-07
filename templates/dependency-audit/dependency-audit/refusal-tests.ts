import assert from "node:assert/strict";
import { fakeStepBridge } from "cloving/workflows/testing";
import { dependencyAudit } from "../dependency-audit.ts";
import {
  advisory,
  candidate,
  completed,
  effects,
  group,
  input,
  methods,
  twoPackages,
} from "./scenarios.ts";

export interface RefusalTest {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export const refusalTests: RefusalTest[] = [];

const candidateRefusals = [
  [
    { kind: "failed" as const, operationId: "c", reason: "command-exit" },
    "command-exit",
  ],
  [
    {
      kind: "completed" as const,
      operationId: "c",
      receipt: null,
      result: "x",
    },
    "invalid-audit-candidates",
  ],
  [
    {
      kind: "completed" as const,
      operationId: "c",
      receipt: null,
      result: null,
    },
    "invalid-audit-candidates",
  ],
  [completed({ candidates: [] }), "invalid-audit-candidates"],
  [
    completed(
      Array.from({ length: 11 }, (_, index) => candidate(`p${String(index)}`)),
    ),
    "invalid-audit-candidates",
  ],
  [completed([7]), "invalid-audit-candidates"],
  [completed([candidate("Bad Name")]), "invalid-audit-candidates"],
  [
    completed([candidate("minimist", { severity: "moderate" })]),
    "invalid-audit-candidates",
  ],
  [
    completed([candidate("minimist", { direct: "no" })]),
    "invalid-audit-candidates",
  ],
  [
    completed([candidate("minimist", { advisories: [] })]),
    "invalid-audit-candidates",
  ],
  [
    completed([
      candidate("minimist", { advisories: [advisory("CVE-2021-44906")] }),
    ]),
    "invalid-audit-candidates",
  ],
  [
    completed([
      candidate("minimist", {
        advisories: [
          Object.assign(advisory("GHSA-xvch-5gv4-984h"), {
            url: "http://example.com",
          }),
        ],
      }),
    ]),
    "invalid-audit-candidates",
  ],
  [
    completed([
      candidate("minimist", {
        advisories: [
          Object.assign(advisory("GHSA-xvch-5gv4-984h"), { patchedRange: 7 }),
        ],
      }),
    ]),
    "invalid-audit-candidates",
  ],
  [
    completed([candidate("minimist", { paths: "minimist@1.0.0" })]),
    "invalid-audit-candidates",
  ],
  [
    completed([candidate("minimist", { pathCount: 0 })]),
    "invalid-audit-candidates",
  ],
  [
    completed([candidate("minimist", { fixAvailable: "yes" })]),
    "invalid-audit-candidates",
  ],
  [
    completed([
      candidate("minimist", {
        fixAvailable: { version: "0.5.6", isSemVerMajor: false },
      }),
    ]),
    "invalid-audit-candidates",
  ],
  [
    completed([
      candidate("minimist", {
        fixAvailable: { name: "mkdirp", version: 7, isSemVerMajor: false },
      }),
    ]),
    "invalid-audit-candidates",
  ],
  [
    completed([
      candidate("minimist", {
        fixAvailable: { name: "mkdirp", version: "0.5.6" },
      }),
    ]),
    "invalid-audit-candidates",
  ],
  [
    completed([candidate("minimist", { range: "x".repeat(201) })]),
    "invalid-audit-candidates",
  ],
  [{ kind: "stopped" as const, operationId: "c", reason: null }, "stopped"],
  [
    { kind: "failed" as const, operationId: "c", reason: "Not a reason" },
    "dependency-audit-failed",
  ],
] as const;

const invalidPlans = [
  {},
  { groups: [] },
  { groups: [7] },
  { groups: [group(["unknown"])] },
  { groups: [group([])] },
  { groups: [group(["undici", "undici"])] },
  { groups: [group(["undici"]), group(["undici"])] },
  {
    groups: [
      group(["undici"], {
        change: {
          kind: "upgrade",
          package: "undici",
          from: "1.0.0",
          to: "2.0.0",
        },
      }),
    ],
  },
  {
    groups: [
      group(["undici"], {
        change: {
          kind: "pin",
          package: "undici",
          from: "1.0.0",
          to: "latest",
        },
      }),
    ],
  },
  {
    groups: [
      group(["undici"], {
        breakingChanges: [
          { version: "2.0.0", change: "x", uses: ["src/a.ts"], action: "y" },
        ],
      }),
    ],
  },
  {
    groups: [
      group(["undici"], {
        breakingChanges: [
          { version: "2.0.0", change: "", uses: [], action: "y" },
        ],
      }),
    ],
  },
  { groups: [group(["undici"], { breakingChanges: [7] })] },
  { groups: [group(["undici"], { sources: ["ftp://example.com/notes"] })] },
  {
    groups: [
      group(["undici"], {
        sources: ["https://github.com/nodejs/undici/pull/42"],
      }),
    ],
  },
  { groups: [Object.assign({}, group(["undici"]), { packages: "undici" })] },
];

refusalTests.push({
  name: "CLV-318 a failed or invalid candidates command blocks the run before the turn",
  run: async () => {
    for (const [result, reason] of candidateRefusals) {
      using bridge = fakeStepBridge({
        effects: { "command run:audit-candidates": [result] },
      });
      assert.deepEqual(await dependencyAudit(input), {
        kind: "blocked",
        cycleId: input.cycleId,
        evidenceId: "dependency-audit",
        reason,
      });
      assert.deepEqual(methods(bridge.requests), ["run:audit-candidates"]);
    }
  },
});

refusalTests.push({
  name: "CLV-318 an invalid plan blocks the run after the work tree is discarded and before any ticket",
  run: async () => {
    for (const plan of invalidPlans) {
      using bridge = fakeStepBridge({ effects: effects(twoPackages, plan) });
      assert.deepEqual(await dependencyAudit(input), {
        kind: "blocked",
        cycleId: input.cycleId,
        evidenceId: "dependency-audit",
        reason: "invalid-audit-plan",
      });
      assert.deepEqual(methods(bridge.requests), [
        "run:audit-candidates",
        "prepare",
        "run-turn",
        "discard",
      ]);
    }
  },
});

refusalTests.push({
  name: "CLV-318 a turn summary that is not JSON or is too long blocks the run",
  run: async () => {
    for (const [summary, reason] of [
      [{ summary: "not json" }, "invalid-audit-plan"],
      [{ result: "no summary" }, "invalid-audit-plan"],
      [
        { summary: JSON.stringify({ groups: [], note: "x".repeat(12001) }) },
        "audit-plan-too-large",
      ],
    ] as const) {
      using bridge = fakeStepBridge({
        effects: Object.assign(effects(twoPackages), {
          "claude run-turn": [completed(summary)],
        }),
      });
      const outcome = await dependencyAudit(input);
      assert.equal(outcome.kind === "blocked" ? outcome.reason : "", reason);
      assert.ok(!methods(bridge.requests).includes("handoff"));
    }
  },
});

refusalTests.push({
  name: "CLV-318 a failed prepare, turn, discard or handoff blocks the run",
  run: async () => {
    const failed = (reason: string) => ({
      kind: "failed" as const,
      operationId: "operation",
      reason,
    });
    for (const [name, reason, expected] of [
      [
        "github prepare",
        "git-call-failed",
        ["run:audit-candidates", "prepare"],
      ],
      [
        "claude run-turn",
        "turn-failed",
        ["run:audit-candidates", "prepare", "run-turn", "discard"],
      ],
      [
        "github discard",
        "work-tree-not-available",
        ["run:audit-candidates", "prepare", "run-turn", "discard"],
      ],
      [
        "handoff",
        "chain-limit",
        ["run:audit-candidates", "prepare", "run-turn", "discard", "handoff"],
      ],
    ] as const) {
      using bridge = fakeStepBridge({
        effects: Object.assign(
          effects(twoPackages, {
            groups: [group(["undici"]), group(["minimist"])],
          }),
          { [name]: [failed(reason)] },
        ),
      });
      assert.deepEqual(await dependencyAudit(input), {
        kind: "blocked",
        cycleId: input.cycleId,
        evidenceId: "dependency-audit",
        reason,
      });
      assert.deepEqual(methods(bridge.requests), expected);
    }
  },
});

refusalTests.push({
  name: "CLV-318 a ticket text above the handoff size blocks the run before any ticket",
  run: async () => {
    const wide = candidate("undici", {
      advisories: Array.from({ length: 20 }, (_, index) =>
        Object.assign(
          advisory(`GHSA-${String(index).padStart(4, "0")}-cccc-dddd`),
          {
            title: "€".repeat(490),
          },
        ),
      ),
      paths: Array.from(
        { length: 20 },
        (_, index) => `p${String(index)}@1.0.0 > ${"€".repeat(480)}@1.0.0`,
      ),
      pathCount: 20,
    });
    using bridge = fakeStepBridge({
      effects: effects([wide], { groups: [group(["undici"])] }),
    });
    const outcome = await dependencyAudit(input);
    assert.equal(
      outcome.kind === "blocked" ? outcome.reason : "",
      "audit-ticket-too-large",
    );
    assert.ok(!methods(bridge.requests).includes("handoff"));
  },
});
