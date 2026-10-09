import assert from "node:assert/strict";
import { test } from "node:test";
import { admitWorkflow } from "../src/workflow-admission.ts";

const helper = "step//cloving/workflows@0.0.0-probe.1//recordEffect";
const workflow = "workflow//./workflows/probe//probe";
const toolchain = {
  sdk: "workflow@5.1.0",
  world: "@workflow/world-local@5.1.0",
  builder: "@workflow/builders@5.0.2",
  node: "v26.9.0",
  dependencies:
    "fca7bc4cc7fe228842e9ba1929bac447fa19dce42f84d45e3c209440b65302d6",
};
const registration = {
  name: "probe",
  workflowId: workflow,
  steps: [helper],
  capabilities: ["fake-harness"],
  resources: ["prompts/implement.md"],
};
const policy = { toolchain, capabilities: ["fake-harness"] };

function packedConsumer(helperSteps: Readonly<Record<string, unknown>>): {
  manifest: unknown;
  artifacts: Readonly<Record<string, string>>;
  resources: Readonly<Record<string, string>>;
  toolchain: typeof toolchain;
} {
  return {
    manifest: {
      classes: {},
      steps: {
        "node_modules/cloving/workflows.js": helperSteps,
        "node_modules/workflow/dist/stdlib.js": {
          fetch: {
            stepId: "step//./node_modules/workflow/dist/stdlib//fetch",
          },
        },
      },
      workflows: {
        "workflows/probe.ts": { probe: { workflowId: workflow } },
      },
    },
    artifacts: { "flow.mjs": "a".repeat(64), "manifest.json": "b".repeat(64) },
    resources: { "prompts/implement.md": "d".repeat(64) },
    toolchain,
  };
}

await test("CLV-005 admission rejects a packed consumer whose imported helper step was not transformed", () => {
  const admitted = admitWorkflow(
    registration,
    packedConsumer({ recordEffect: { stepId: helper } }),
    policy,
  );
  assert.equal(admitted.kind, "admitted");
  assert.deepEqual(admitWorkflow(registration, packedConsumer({}), policy), {
    kind: "rejected",
    reason: "unresolved-step",
    detail: helper,
  });
});

await test("CLV-005 admission rejects unresolved workflows, duplicate identities and malformed manifests", () => {
  const valid = packedConsumer({ recordEffect: { stepId: helper } });
  const manifest = fields(valid.manifest);
  const steps = fields(manifest["steps"]);
  for (const [changed, reason] of [
    [{ ...manifest, workflows: {} }, "unresolved-workflow"],
    [
      {
        ...manifest,
        steps: { ...steps, "src/copy.js": { copy: { stepId: helper } } },
      },
      "duplicate-registration",
    ],
    [{ ...manifest, steps: [] }, "invalid-manifest"],
    [
      {
        ...manifest,
        steps: { ...steps, "src/bad.js": { bad: { stepId: 1 } } },
      },
      "invalid-manifest",
    ],
    [null, "invalid-manifest"],
  ] as const) {
    const result = admitWorkflow(
      registration,
      { ...valid, manifest: changed },
      policy,
    );
    assert.equal(
      result.kind === "rejected" ? result.reason : result.kind,
      reason,
    );
  }
});

function fields(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value));
}

await test("CLV-005 admission rejects incompatible toolchains, unsupported capabilities and invalid registrations", () => {
  const valid = packedConsumer({ recordEffect: { stepId: helper } });
  for (const [changed, reason, detail] of [
    [
      { ...valid, toolchain: { ...toolchain, sdk: "workflow@5.2.0" } },
      "incompatible-toolchain",
      "sdk",
    ],
    [
      { ...valid, toolchain: { ...toolchain, dependencies: "c".repeat(64) } },
      "incompatible-toolchain",
      "dependencies",
    ],
    [
      { ...valid, toolchain: { ...toolchain, node: "v24.18.0" } },
      "incompatible-toolchain",
      "node",
    ],
  ] as const)
    assert.deepEqual(admitWorkflow(registration, changed, policy), {
      kind: "rejected",
      reason,
      detail,
    });
  assert.deepEqual(
    admitWorkflow(
      { ...registration, capabilities: ["network"] },
      valid,
      policy,
    ),
    { kind: "rejected", reason: "unsupported-capability", detail: "network" },
  );
  for (const changed of [
    { ...registration, name: " " },
    { ...registration, steps: [helper, helper] },
    { ...registration, capabilities: ["fake-harness", "fake-harness"] },
  ])
    assert.deepEqual(admitWorkflow(changed, valid, policy), {
      kind: "rejected",
      reason: "invalid-registration",
      detail: "registration",
    });
});

await test("CLV-005 the admitted manifest is an immutable copy with code digests", () => {
  const compiled = packedConsumer({ recordEffect: { stepId: helper } });
  const artifacts = { ...compiled.artifacts };
  const steps = [...registration.steps];
  const extended = { ...registration, steps, extra: "ignored" };
  const result = admitWorkflow(extended, { ...compiled, artifacts }, policy);
  assert.equal(result.kind, "admitted");
  artifacts["flow.mjs"] = "c".repeat(64);
  steps.push("step//other");
  assert.deepEqual(result.manifest.artifacts, compiled.artifacts);
  assert.deepEqual(result.manifest.steps, [helper]);
  assert.equal("extra" in result.manifest, false);
  assert.ok(Object.isFrozen(result.manifest));
  assert.ok(Object.isFrozen(result.manifest.artifacts));
  assert.deepEqual(
    admitWorkflow(registration, { ...compiled, artifacts: {} }, policy),
    { kind: "rejected", reason: "invalid-artifacts", detail: "artifacts" },
  );
});

await test("CLV-005 admission tags untrusted registration, artifact and toolchain data instead of throwing", () => {
  const valid = packedConsumer({ recordEffect: { stepId: helper } });
  for (const [candidate, compiled, reason, detail] of [
    [
      { ...registration, name: 1 },
      valid,
      "invalid-registration",
      "registration",
    ],
    [
      { ...registration, steps: null },
      valid,
      "invalid-registration",
      "registration",
    ],
    [null, valid, "invalid-registration", "registration"],
    [
      registration,
      { ...valid, toolchain: undefined },
      "incompatible-toolchain",
      "sdk",
    ],
    [registration, null, "incompatible-toolchain", "sdk"],
    [
      registration,
      { ...valid, artifacts: { "flow.mjs": "" } },
      "invalid-artifacts",
      "artifacts",
    ],
    [
      registration,
      { ...valid, artifacts: null },
      "invalid-artifacts",
      "artifacts",
    ],
  ] as const)
    assert.deepEqual(admitWorkflow(candidate, compiled, policy), {
      kind: "rejected",
      reason,
      detail,
    });
  const result = admitWorkflow(
    registration,
    { ...valid, toolchain: { ...toolchain, extra: "ignored" } },
    policy,
  );
  assert.equal(result.kind, "admitted");
  assert.deepEqual(result.manifest.toolchain, toolchain);
});

await test("CLV-005 every artifact digest survives admission, including inherited property names", () => {
  const valid = packedConsumer({ recordEffect: { stepId: helper } });
  const artifacts: unknown = JSON.parse(
    `{"__proto__":"${"a".repeat(64)}","flow.mjs":"${"b".repeat(64)}"}`,
  );
  const result = admitWorkflow(registration, { ...valid, artifacts }, policy);
  assert.equal(result.kind, "admitted");
  assert.deepEqual(Object.keys(result.manifest.artifacts), [
    "__proto__",
    "flow.mjs",
  ]);
});

await test("CLV-005 admission rejects layout-dependent and unversioned step identities", () => {
  for (const unversioned of [
    "step//./node_modules/cloving/dist/src/steps/load-cycle//loadCycle",
    "step//cloving/workflows/steps/load-cycle//loadCycle",
    "step//../x@1//f",
  ]) {
    const valid = packedConsumer({ loadCycle: { stepId: unversioned } });
    assert.deepEqual(
      admitWorkflow({ ...registration, steps: [unversioned] }, valid, policy),
      { kind: "rejected", reason: "unversioned-step", detail: unversioned },
    );
  }
});

await test("CLV-005 admission rejects declared resources that discovery could not read", () => {
  const valid = packedConsumer({ recordEffect: { stepId: helper } });
  const result = admitWorkflow(registration, valid, policy);
  assert.equal(result.kind, "admitted");
  assert.deepEqual(result.manifest.resources, valid.resources);
  for (const resources of [{}, { "prompts/implement.md": "missing" }, null])
    assert.deepEqual(
      admitWorkflow(registration, { ...valid, resources }, policy),
      {
        kind: "rejected",
        reason: "inaccessible-resource",
        detail: "prompts/implement.md",
      },
    );
  assert.deepEqual(
    admitWorkflow({ ...registration, resources: "prompts" }, valid, policy),
    {
      kind: "rejected",
      reason: "invalid-registration",
      detail: "registration",
    },
  );
});
