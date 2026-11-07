import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  productRoot,
  servicePrelude,
  withConsumer,
} from "./world-host-fixture.ts";

const commands = JSON.stringify(
  pathToFileURL(join(productRoot, "src/cli/commands.ts")).href,
);

const workflows = `
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

const step = (scope, payload) =>
  protectedEffect({ scope, capability: "fake-harness", method: "run-turn", target: "workspace/main", payload, units: 1 });

export async function develop(input: { cycleId: string }) {
  "use workflow";
  await step({ phase: "implement", operation: "claude-turn", round: 1 }, "turn " + input.cycleId);
  await step({ phase: "pull-request", operation: "github-open-pr", round: 1 }, "open " + input.cycleId);
  const merge = await step({ phase: "merge", operation: "merge", round: 1 }, "merge " + input.cycleId);
  if (merge.kind !== "completed") throw new Error(merge.reason ?? merge.kind);
  return { kind: "handoff_requested", cycleId: input.cycleId };
}
`;

const failingPrelude = `${servicePrelude}
const failing = {
  ...destination,
  deliver: async (intent) => {
    appendFileSync("sent.log", JSON.parse(intent.operationId)[4] + "\\n");
    if (existsSync("fail-merge") && JSON.parse(intent.operationId)[4] === "merge") return { kind: "failed", reason: "git-call-failed", receipt: null, worker: null };
    return await destination.deliver(intent);
  },
};
const finalState = async (runId) => { await until(async () => ["completed", "failed"].includes(await stateOf(runId))); return await stateOf(runId); };
const continued = (parameters) => asked("continue-run", { commandId: "c-continue", ...parameters });
const outputOf = async (runId) => { const world = (await tagged()).filter((run) => run.run === runId && run.status === "completed"); return world.length === 0 ? null : await getRun(world[0].receipt).returnValue; };
writeFileSync("fail-merge", "");
`;

const scene = `${failingPrelude}
const service = await hosted({ destination: failing });
const runId = await submitted("c-1");
const before = await finalState(runId);
`;

await test("CLV-307 a run whose merge failed continues, the new run sends only the merge again, and it keeps the cycle of the old run", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${scene}
rmSync("fail-merge");
const { runtimeCommand } = await import(${commands});
const output = [];
const terminal = { out: (text) => output.push(text), error: (text) => output.push(text) };
const environment = { runtimeDirectory, workingDirectory: ".", terminal, identifier: () => "c-continue", interrupted: () => new Promise(() => undefined) };
const exit = await runtimeCommand({ kind: "continue", runId, from: null, bundle: "retained", commandId: null, json: true }, environment);
const reply = JSON.parse(output.join(""));
const after = await finalState(reply.runId);
print({ before, exit, kind: reply.kind, continued: reply.continuedFrom === runId, after, sent: lines("sent.log"), output: await outputOf(reply.runId), old: await stateOf(runId) });
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines[0], {
      before: "failed",
      exit: 0,
      kind: "run-continued",
      continued: true,
      after: "completed",
      sent: ["claude-turn", "github-open-pr", "merge", "merge"],
      output: { kind: "handoff_requested", cycleId: "cycle-1" },
      old: "failed",
    });
  }));

await test("CLV-307 a continuation from a named step sends that step and every later step again", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${scene}
rmSync("fail-merge");
const reply = await continued({ runId, from: "pull-request/github-open-pr" });
print({ after: await finalState(reply.runId), sent: lines("sent.log") });
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines[0], {
      after: "completed",
      sent: [
        "claude-turn",
        "github-open-pr",
        "merge",
        "github-open-pr",
        "merge",
      ],
    });
  }));

await test("CLV-307 the service refuses a continuation of an active run and of an unknown run", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${servicePrelude}
writeFileSync("hold-effect", "");
const service = await hosted();
const runId = await submitted("c-1");
await until(async () => lines("destination.log").length > 0);
const active = await asked("continue-run", { runId, commandId: "c-continue" });
const unknown = await asked("continue-run", { runId: "run-unknown", commandId: "c-continue-2" });
rmSync("hold-effect");
print({ active: [active.kind, active.code], unknown: [unknown.kind, unknown.code] });
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines[0], {
      active: ["error", "run-active"],
      unknown: ["error", "unknown-run"],
    });
  }));

await test("CLV-308 a continued first run keeps the chain limit of its chain and its spend limit", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${failingPrelude}
const service = await hosted({ destination: failing, registrations: [{ ...fakeRegistration([]), effectLimit: 5, chainLimit: 2, spendLimitUsd: 3 }] });
const runId = await submitted("c-1");
const before = await finalState(runId);
rmSync("fail-merge");
const reply = await continued({ runId });
const after = await finalState(reply.runId);
const limitsOf = async (id) => { const { run } = await asked("status", { runId: id }); return [run.chain, run.spendLimitUsd]; };
print({ before, after, limits: [await limitsOf(runId), await limitsOf(reply.runId)] });
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines[0], {
      before: "failed",
      after: "completed",
      limits: [
        [{ position: 1, limit: 2 }, 3],
        [{ position: 1, limit: 2 }, 3],
      ],
    });
  }));
