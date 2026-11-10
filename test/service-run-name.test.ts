import assert from "node:assert/strict";
import { test } from "node:test";
import { servicePrelude, withConsumer } from "./world-host-fixture.ts";

const workflows = `
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

const step = (scope, method, payload) =>
  protectedEffect({ scope, capability: "fake-harness", method, target: "workspace/main", payload, units: 1 });

export async function develop(input: { cycleId: string }) {
  "use workflow";
  await step({ phase: "pull-request", operation: "github-open-pr", round: 1 }, "open-pr", "open 1 " + input.cycleId);
  await step({ phase: "pull-request", operation: "github-open-pr", round: 2 }, "open-pr", "open 2 " + input.cycleId);
  return { kind: "handoff_requested", cycleId: input.cycleId };
}
`;

await test("CLV-334 a run with no ticket title takes the title of its newest pull request and the ticket key in it, and a ticket run keeps its ticket name", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${servicePrelude}
const titles = { 1: "SID-4800: An older title", 2: "SID-4820: Filter and page Notion database files" };
const titled = {
  ...destination,
  deliver: async (intent) => {
    const outcome = await destination.deliver(intent);
    const round = JSON.parse(intent.operationId)[1];
    if (globalThis.currentRun === "untitled") return { ...outcome, result: round === 1 ? JSON.stringify({ number: 686, url: "https://github.com/acme/demo/pull/686" }) : "not json" };
    return { ...outcome, result: JSON.stringify({ number: 686, url: "https://github.com/acme/demo/pull/686", title: titles[round] }) };
  },
};
const registration = fakeRegistration([]);
const resolver = {
  ...registration.resolver,
  resolve: async (request) => {
    const ticket = request.submission.prompt.endsWith("ticket");
    return { kind: "resolved", input: ticket ? { cycleId: "cycle-ticket", ticketId: "CLV-261", ticket: "# CLV-261: Run the daemon tests\\nBody" } : { cycleId: "cycle-plain" } };
  },
};
const service = await hosted({ destination: titled, registrations: [{ ...registration, resolver, effectLimit: 5, manifest: { ...registration.manifest, capabilities: ["fake-harness"] } }] });
const names = {};
for (const name of ["plain", "ticket", "untitled"]) {
  globalThis.currentRun = name;
  const runId = await submitted(name);
  await until(async () => (await stateOf(runId)) === "completed");
  const run = (await asked("status", { runId })).run;
  names[name] = [run.title, run.titleSource, run.label, run.labelSource];
}
print(names);
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines[0], {
      plain: [
        "SID-4820: Filter and page Notion database files",
        "pull-request",
        "SID-4820",
        "title",
      ],
      ticket: ["CLV-261: Run the daemon tests", "ticket", "CLV-261", "ticket"],
      untitled: ["task of untitled", "prompt", null, null],
    });
  }));
