import assert from "node:assert/strict";
import { test } from "node:test";
import { isWorkflowDeclaration } from "../src/workflow-declaration.ts";
import { checkWorkflowCandidate } from "../src/workflow-candidate.ts";
import { workflowRefusals } from "../src/workflow-refusals.ts";
import { workflowConflicts } from "../src/workflow-discovery.ts";
import { requiredDoctorCodes } from "../src/doctor-report.ts";
import {
  ticketRegistrations,
  ticketRegistrationTable,
} from "../src/daemon/ticket-registration.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";
import { manifest } from "./authority-store-fixture.ts";
import {
  declaredManifest,
  pinnedIdentity,
  readExecutionManifest,
  resumePinned,
} from "../src/execution-pin.ts";

const workflow = {
  ...candidateDeclaration.workflow,
  queue: true,
  input: { maximumBytes: 4096, fields: { ticket: { type: "ticket" } } },
} as const;

await test("CLV-218 queue is an optional boolean and accepts optional extra input", () => {
  assert.ok(isWorkflowDeclaration(workflow));
  assert.ok(isWorkflowDeclaration({ ...workflow, queue: false }));
  assert.ok(isWorkflowDeclaration(candidateDeclaration.workflow));
  for (const queue of ["true", 1, null])
    assert.equal(isWorkflowDeclaration({ ...workflow, queue }), false);
  assert.ok(
    isWorkflowDeclaration({
      ...workflow,
      input: {
        ...workflow.input,
        fields: {
          ...workflow.input.fields,
          note: { type: "string", optional: true },
        },
      },
    }),
  );
});

for (const [fields, code] of [
  [{}, "queue-needs-ticket-field"],
  [{ ticket: { type: "string" } }, "queue-needs-ticket-field"],
  [
    { ticket: { type: "ticket" }, note: { type: "string" } },
    "queue-input-incomplete",
  ],
] as const) {
  await test(`CLV-218 incomplete queue input gives ${code}`, () => {
    const declaration = { ...workflow, input: { ...workflow.input, fields } };
    assert.equal(isWorkflowDeclaration(declaration), false);
    assert.deepEqual(
      checkWorkflowCandidate({
        declaration: { ...candidateDeclaration, workflow: declaration },
        analysis: {
          imports: [],
          effects: [],
          directEffects: [],
          unsupportedForms: [],
          knownCallCount: 0,
          knownUnitTotal: 0,
        },
        installedExports: {},
      }),
      [code],
    );
    const refusal = { scope: "project", label: "queue.ts", codes: [code] };
    assert.deepEqual(workflowRefusals([refusal]), [refusal]);
  });
}

await test("CLV-218 queue declarations conflict across workflow identities", async () => {
  const identities = ["one", "two"].map((name) => ({
    baseName: name,
    workflowId: name,
    functionNames: [name],
    queue: true,
  }));
  assert.deepEqual(workflowConflicts(identities, []), [
    ["queue-workflow-conflict"],
    ["queue-workflow-conflict"],
  ]);
  const table = ticketRegistrationTable(
    { repository: "repository", command: undefined },
    ["one", "two"].map((workflowId) => ({
      ...workflow,
      workflowId,
      functionName: workflowId,
    })),
  );
  assert.deepEqual(await ticketRegistrations({}, { table }), {
    kind: "rejected",
    detail: "queue-workflow-conflict: one, two",
  });
  const refusal = {
    scope: "user",
    label: "two.ts",
    codes: ["queue-workflow-conflict"],
  };
  assert.deepEqual(workflowRefusals([refusal]), [refusal]);
});

await test("CLV-218 declared queue workflows require next command and interval without settings", () => {
  const codes = requiredDoctorCodes([{ ...workflow, scope: "project" }]);
  assert.ok(codes.includes("next-command"));
  assert.ok(codes.includes("queue-interval"));
});

await test("CLV-218 queue membership survives serialization and changes the execution pin", () => {
  const queued = declaredManifest(manifest, { queue: true });
  assert.equal(queued.queue, true);
  assert.deepEqual(
    readExecutionManifest(JSON.parse(JSON.stringify(queued))),
    queued,
  );
  assert.notEqual(pinnedIdentity(queued), pinnedIdentity(manifest));
  assert.equal(
    pinnedIdentity({ ...manifest, queue: false }),
    pinnedIdentity(manifest),
  );
  assert.deepEqual(resumePinned(queued, manifest), {
    kind: "rejected",
    reason: "pinned-manifest-mismatch",
    detail: "queue",
  });
  assert.throws(
    () => readExecutionManifest({ ...manifest, queue: "true" }),
    /invalid-queue/,
  );
});
