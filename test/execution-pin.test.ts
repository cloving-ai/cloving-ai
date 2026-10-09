import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pinnedIdentity,
  readExecutionManifest,
  resumePinned,
} from "../src/execution-pin.ts";

const pinned = {
  name: "probe",
  workflowId: "workflow//./workflows/probe//probe",
  steps: [
    "step//cloving/workflows@0.4.0//loadCycle",
    "step//cloving/workflows@0.4.0//recordEffect",
  ],
  capabilities: ["fake-harness", "tracker"],
  artifacts: { "flow.mjs": "a".repeat(64), "steps.mjs": "b".repeat(64) },
  resources: { "prompts/implement.md": "e".repeat(64) },
  toolchain: {
    sdk: "workflow@5.1.0",
    world: "@workflow/world-local@5.1.0",
    builder: "@workflow/builders@5.0.2",
    node: "v26.9.0",
    dependencies: "c".repeat(64),
  },
};

await test("CLV-005 the same complete artifact yields one pinned identity", () => {
  assert.equal(
    pinnedIdentity({
      ...pinned,
      steps: [...pinned.steps].reverse(),
      capabilities: [...pinned.capabilities].reverse(),
      artifacts: { "steps.mjs": "b".repeat(64), "flow.mjs": "a".repeat(64) },
    }),
    pinnedIdentity(pinned),
  );
  assert.notEqual(
    pinnedIdentity({
      ...pinned,
      artifacts: { ...pinned.artifacts, "steps.mjs": "d".repeat(64) },
    }),
    pinnedIdentity(pinned),
  );
});

await test("CLV-005 a waiting run resumes only with its pinned artifact", () => {
  assert.deepEqual(resumePinned(pinned, pinned), {
    kind: "admitted",
    manifest: pinned,
  });
  for (const [available, detail] of [
    [
      {
        ...pinned,
        artifacts: { ...pinned.artifacts, "steps.mjs": "d".repeat(64) },
      },
      "artifacts",
    ],
    [
      { ...pinned, toolchain: { ...pinned.toolchain, sdk: "workflow@5.2.0" } },
      "toolchain",
    ],
    [
      { ...pinned, workflowId: "workflow//./workflows/other//probe" },
      "workflowId",
    ],
    [{ ...pinned, steps: [pinned.steps[0] ?? ""] }, "steps"],
    [
      { ...pinned, resources: { "prompts/implement.md": "f".repeat(64) } },
      "resources",
    ],
  ] as const)
    assert.deepEqual(resumePinned(pinned, available), {
      kind: "rejected",
      reason: "pinned-manifest-mismatch",
      detail,
    });
});

await test("CLV-005 pinned identities order artifact names by code unit on every host", () => {
  const identity = pinnedIdentity({
    ...pinned,
    artifacts: { "a.mjs": "a".repeat(64), "B.mjs": "b".repeat(64) },
  });
  assert.ok(identity.indexOf("B.mjs") < identity.indexOf("a.mjs"));
});

await test("CLV-007 a stored manifest reads back to the same pinned identity and malformed fields read as empty", () => {
  const stored: unknown = JSON.parse(JSON.stringify(pinned));
  assert.deepEqual(readExecutionManifest(stored), pinned);
  const empty = {
    name: "",
    workflowId: "",
    steps: [],
    capabilities: [],
    artifacts: {},
    resources: {},
    toolchain: { sdk: "", world: "", builder: "", node: "", dependencies: "" },
  };
  for (const value of [null, [], "manifest", { toolchain: [] }])
    assert.deepEqual(readExecutionManifest(value), empty);
  assert.deepEqual(
    readExecutionManifest({
      ...pinned,
      name: 5,
      steps: "step",
      capabilities: [1],
      artifacts: { "flow.mjs": 2 },
    }),
    {
      ...pinned,
      name: "",
      steps: [],
      capabilities: [""],
      artifacts: { "flow.mjs": "" },
    },
  );
});
