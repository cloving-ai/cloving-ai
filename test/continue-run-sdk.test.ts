import assert from "node:assert/strict";
import { test } from "node:test";
import { withConsumer } from "./world-host-fixture.ts";
import { queuePrelude } from "./daemon-queue-fixture.ts";

const workflow = `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { continueRun } from "cloving/workflows/steps/continue-run";
import { handoff } from "cloving/workflows/steps/handoff";
import { waitForRun } from "cloving/workflows/steps/wait-for-run";
export async function received(outcome) {
  "use step";
  appendFileSync("outcomes", JSON.stringify(outcome) + "\\n");
  writeFileSync("fixed", "");
}
export async function prompt() {
  "use step";
  return existsSync("fixed") ? "fixed" : 5;
}
export async function parent(input) {
  "use workflow";
  if (input.input.outside !== undefined) {
    try {
      await continueRun({ runId: input.input.outside });
    } catch (error) {
      return { kind: "blocked", cycleId: input.cycleId, evidenceId: "fixture", reason: error.message };
    }
  }
  const child = await handoff({ workflowId: "child", input: {} });
  const first = await waitForRun({ runId: child, maximumWaitSeconds: 60 });
  await received({ kind: first.kind });
  const next = await continueRun({ runId: child });
  const second = await waitForRun({ runId: next, maximumWaitSeconds: 60 });
  await received({ kind: second.kind });
  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: next };
}
export async function child(input) {
  "use workflow";
  const value = await prompt();
  const leaf = await handoff({ workflowId: "leaf", input: { prompt: value } });
  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: leaf };
}
export async function leaf(input) {
  "use workflow";
  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: input.input.prompt };
}
`;

const prelude = `${queuePrelude}
settings.queueMilliseconds = undefined;
settings.runWaitChecks = { firstMilliseconds: 1000, maximumMilliseconds: 1000 };
for (const name of ["parent", "child", "leaf"]) {
  const definition = Object.values(compiled.workflows).flatMap(Object.values).find((entry) => entry.workflowId.endsWith("//" + name));
  writeFileSync(name + ".workflow.json", JSON.stringify({ schemaVersion: 1, name, workflowId: definition.workflowId, steps: [], capabilities: [], resources: [], artifacts: "artifacts" }));
  settings.manifests[name] = directory + "/" + name + ".workflow.json";
  settings.workflows[name] = workflows[name];
}
settings.declarations = [
  { workflowId: "parent", functionName: "parent", effectLimit: 2, capabilities: [], handoffs: ["child"], input: { maximumBytes: 4096, fields: { outside: { type: "string", optional: true } } } },
  { workflowId: "child", functionName: "child", effectLimit: 1, capabilities: [], handoffs: ["leaf"], input: { maximumBytes: 4096, fields: {} } },
  { workflowId: "leaf", functionName: "leaf", effectLimit: 0, capabilities: [], input: { maximumBytes: 4096, fields: { prompt: { type: "string" } } } },
];
const ended = (runId) => until(async () => { const run = await shown(runId); return ["completed", "failed", "cancelled"].includes(run?.state) ? run : undefined; });
const outcomes = () => existsSync("outcomes") ? readFileSync("outcomes", "utf8").trim().split("\\n").map(JSON.parse) : [];
`;

await test("CLV-307 a workflow continues a failed run of its own handoff chain and waits for the continuation", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`${prelude}
const daemon = await launched();
try {
  const root = await submitted("parent-root", { workflowId: "parent", source: "input", submission: {} });
  const completed = await ended(root.runId);
  const children = (await runs()).filter((run) => run.workflowId === "child");
  const old = children.find((run) => run.continuedFrom === undefined);
  const next = children.find((run) => run.continuedFrom !== undefined);
  print({
    outcome: completed.outcome?.kind,
    promoted: completed.outcome?.promotionId === next?.runId,
    budget: completed.budget,
    children: children.length,
    old: (await shown(old.runId)).state,
    links: [(await shown(old.runId)).continuedBy === next.runId, next.continuedFrom === old.runId],
    next: (await ended(next.runId)).outcome?.kind,
    outcomes: outcomes(),
  });
} finally { await daemon.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines[0], {
      outcome: "handoff_requested",
      promoted: true,
      budget: { limit: 2, spent: 2 },
      children: 2,
      old: "failed",
      links: [true, true],
      next: "handoff_requested",
      outcomes: [{ kind: "failed" }, { kind: "handoff_requested" }],
    });
  }));

await test("CLV-307 a workflow cannot continue a run outside its handoff chain", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`${prelude}
const daemon = await launched();
try {
  const other = await submitted("other-root", { workflowId: "child", source: "input", submission: {} });
  const failed = await ended(other.runId);
  const root = await submitted("parent-root", { workflowId: "parent", source: "input", submission: { outside: other.runId } });
  const completed = await ended(root.runId);
  print({
    other: failed.state,
    outcome: [completed.outcome?.kind, completed.outcome?.reason.endsWith(": continuation-outside-chain")],
    budget: completed.budget,
    continuedBy: (await shown(other.runId)).continuedBy ?? null,
    runs: (await runs()).length,
  });
} finally { await daemon.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines[0], {
      other: "failed",
      outcome: ["blocked", true],
      budget: { limit: 2, spent: 1 },
      continuedBy: null,
      runs: 2,
    });
  }));
