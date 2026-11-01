import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { record } from "../src/protocol.ts";
import { call } from "./service-fixture.ts";
import { field, items, reached } from "./self-host-fixture.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";

export interface OperatorRestart {
  readonly root: string;
  readonly repository: string;
  readonly runtimeDirectory: string;
}

export interface OperatorDaemon {
  readonly address: string;
  readonly stop: () => Promise<void>;
}

export const restartRefusals = [
  { scope: "user", label: "refused.ts", codes: ["invalid-declaration"] },
];

export async function restartFiles(fixture: OperatorRestart, version: string) {
  for (const scope of ["project", "user"]) {
    const folder =
      scope === "project"
        ? join(fixture.repository, ".cloving/workflows")
        : join(fixture.root, "config/cloving/workflows");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, `${scope}.ts`),
      `
import { decisionGate } from "cloving/workflows/steps/decision-gate";
export async function ${scope}Operator(input: { cycleId: string; repository: string; input: { repository: string } }, continuation?: { gateId: string; decision: string; answer: string | null }) {
  "use workflow";
  if (continuation !== undefined) {
    return { kind: continuation.gateId === "operator-answer" && continuation.decision === "answered" && continuation.answer === ${JSON.stringify(version)} && input.repository === ${JSON.stringify(fixture.repository)} && input.input.repository === "submitted-override" ? "handoff_requested" : "blocked", reason: ${JSON.stringify(version)} };
  }
  const gate = await decisionGate({ gateId: "operator-answer", kind: "question", prompt: ${JSON.stringify(`${scope}:${version}`)} });
  return gate.kind === "opened" ? { kind: "waiting_for_decision", cycleId: input.cycleId, decisionId: gate.decisionId } : { kind: "blocked" };
}`,
    );
    await writeFile(
      join(folder, `${scope}.declaration.json`),
      JSON.stringify({
        ...candidateDeclaration,
        workflow: {
          ...candidateDeclaration.workflow,
          workflowId: `${scope}-operator`,
          input: {
            maximumBytes: 1024,
            fields: { repository: { type: "string" } },
          },
        },
      }),
    );
  }
  const folder = join(fixture.root, "config/cloving/workflows");
  await writeFile(
    join(folder, "refused.ts"),
    'export async function refused() { "use workflow"; return "PRIVATE_SOURCE_SENTINEL"; }',
  );
  await writeFile(join(folder, "refused.declaration.json"), "{}");
}

export async function operatorInventory(
  fixture: OperatorRestart,
  address: string,
) {
  const status = await call(fixture, { operation: "status", parameters: {} });
  assert.deepEqual(status["workflows"], ["project-operator", "user-operator"]);
  assert.deepEqual(status["workflowRefusals"], restartRefusals);
  const response = await fetch(`${address}data.json`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const model = record(await response.json());
  assert.ok(model, "Operator watch data must be a JSON object.");
  assert.deepEqual(model["workflowRefusals"], restartRefusals);
  assert.doesNotMatch(
    JSON.stringify([status, model]),
    /PRIVATE_SOURCE_SENTINEL/,
  );
  const refused = await call(fixture, {
    operation: "run",
    parameters: {
      workflowId: "refused",
      source: "declared",
      commandId: "refused",
      submission: {},
    },
  });
  assert.equal(refused["code"], "unknown-workflow");
}

export async function operatorQuestion(
  fixture: OperatorRestart,
  runId: string,
) {
  return await reached(async () => {
    const questions = await call(fixture, {
      operation: "questions",
      parameters: { runId },
    });
    const status = await call(fixture, {
      operation: "status",
      parameters: { runId },
    });
    return field(status["run"], "state") === "waiting_gate"
      ? items(questions["decisions"])[0]
      : undefined;
  });
}

export async function settledOperatorSegments(fixture: OperatorRestart) {
  const folder = join(dirname(fixture.runtimeDirectory), "world/runs");
  return await reached(async () => {
    const files = (await readdir(folder)).filter((name) =>
      name.endsWith(".json"),
    );
    const runs = await Promise.all(
      files.map(async (file) => {
        const run = record(
          JSON.parse(await readFile(join(folder, file), "utf8")),
        );
        assert.ok(run, "Operator run must be a JSON object.");
        return run;
      }),
    );
    return runs.length > 0 && runs.every((run) => run["status"] === "completed")
      ? runs
      : undefined;
  });
}

export async function waitingOperator(
  fixture: OperatorRestart,
  input: { readonly scope: string; readonly version: string },
) {
  const { scope, version } = input;
  const admitted = await call(fixture, {
    operation: "run",
    parameters: {
      workflowId: `${scope}-operator`,
      source: "declared",
      commandId: `${scope}-${version}`,
      submission: { repository: "submitted-override" },
    },
  });
  assert.equal(admitted["kind"], "run-admitted", JSON.stringify(admitted));
  assert.equal(typeof admitted["runId"], "string");
  const runId = String(admitted["runId"]);
  const question = await operatorQuestion(fixture, runId);
  assert.equal(field(question, "prompt"), `${scope}:${version}`);
  await reached(async () => {
    const events = await call(fixture, {
      operation: "events",
      parameters: { runId, after: 0, limit: 100 },
    });
    return JSON.stringify(events).includes("gate.wait-registered")
      ? events
      : undefined;
  });
  await settledOperatorSegments(fixture);
  return { runId, question };
}

export async function answeredOperator(
  fixture: OperatorRestart,
  input: { readonly runId: string; readonly version: string },
) {
  const { runId, version } = input;
  const question = await operatorQuestion(fixture, runId);
  const answer = await call(fixture, {
    operation: "decision",
    parameters: {
      command: "answer",
      reference: field(question, "decisionId"),
      text: version,
      subjectDigest: field(question, "subjectDigest"),
      expectedRevision: field(question, "revision"),
      generation: field(question, "generation"),
      commandId: `answer-${runId}`,
    },
  });
  assert.equal(answer["kind"], "decision-recorded", JSON.stringify(answer));
  const run = await reached(async () => {
    const status = await call(fixture, {
      operation: "status",
      parameters: { runId },
    });
    const run = status["run"];
    return ["completed", "blocked", "failed"].includes(
      String(field(run, "state")),
    ) || field(field(run, "reason"), "code") === "pinned-workflow-unavailable"
      ? run
      : undefined;
  });
  assert.equal(field(run, "state"), "completed", JSON.stringify(run));
  assert.deepEqual(field(run, "outcome"), {
    kind: "handoff_requested",
    reason: version,
  });
  assert.deepEqual(field(run, "budget"), { limit: 1, spent: 0 });
  await settledOperatorSegments(fixture);
}

export async function operatorRestart(
  fixture: OperatorRestart,
  start: () => Promise<OperatorDaemon>,
) {
  await restartFiles(fixture, "v1");
  const first = await start();
  const waiting = [];
  try {
    await operatorInventory(fixture, first.address);
    for (const scope of ["project", "user"])
      waiting.push(await waitingOperator(fixture, { scope, version: "v1" }));
  } finally {
    await first.stop();
  }
  await restartFiles(fixture, "v2");
  const second = await start();
  try {
    await operatorInventory(fixture, second.address);
    for (const original of waiting) {
      assert.deepEqual(
        await operatorQuestion(fixture, original.runId),
        original.question,
      );
      await answeredOperator(fixture, { runId: original.runId, version: "v1" });
    }
    for (const scope of ["project", "user"]) {
      const current = await waitingOperator(fixture, { scope, version: "v2" });
      await answeredOperator(fixture, { runId: current.runId, version: "v2" });
    }
  } finally {
    await second.stop();
  }
}
