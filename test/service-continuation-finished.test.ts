import assert from "node:assert/strict";
import { test } from "node:test";
import { servicePrelude, withConsumer } from "./world-host-fixture.ts";

const workflows = `
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

const step = (scope, method, payload) =>
  protectedEffect({ scope, capability: "fake-harness", method, target: "workspace/main", payload, units: 1 });

export async function develop(input: { cycleId: string }) {
  "use workflow";
  await step({ phase: "pull-request", operation: "github-open-pr", round: 1 }, "open-pr", "open " + input.cycleId);
  const merge = await step({ phase: "merge", operation: "merge", round: 1 }, "run-turn", "merge " + input.cycleId);
  if (merge.kind !== "completed") throw new Error(merge.reason ?? merge.kind);
  return { kind: "handoff_requested", cycleId: input.cycleId };
}
`;

await test("CLV-321 the service refuses a continuation of a run whose ticket is closed or whose pull request is merged", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${servicePrelude}
const failing = {
  ...destination,
  deliver: async (intent) => {
    const operation = JSON.parse(intent.operationId)[4];
    if (operation === "merge") return { kind: "failed", reason: "git-call-failed", receipt: null, worker: null };
    const outcome = await destination.deliver(intent);
    const ticket = Number(globalThis.currentTicket);
    if (ticket === 600) return { ...outcome, result: "not json" };
    return { ...outcome, result: JSON.stringify({ number: ticket + 100, url: "https://github.com/cloving-ai/cloving-ai/pull/" + String(ticket + 100) }) };
  },
};
const registration = fakeRegistration([]);
const resolver = {
  ...registration.resolver,
  resolve: async (request) => {
    const ticket = /[0-9]+/.exec(request.submission.prompt)[0];
    return { kind: "resolved", input: { cycleId: "cycle-" + ticket, ticketId: ticket, ticket: ticket === "600" ? "# Ticket 600" : "# Ticket " + ticket + "\\n\\nGitHub issue: cloving-ai/cloving-ai#" + ticket + "\\n" } };
  },
};
const reads = [];
const githubRead = { read: async (path) => {
  reads.push(path);
  if (path.endsWith("/692")) throw new Error("github-call-failed");
  if (path.includes("/issues/")) return { state: path.endsWith("/586") ? "closed" : "open" };
  return { merged: path.endsWith("/690") };
} };
const service = await hosted({ destination: failing, githubRead, registrations: [{ ...registration, resolver, effectLimit: 5, manifest: { ...registration.manifest, capabilities: ["fake-harness"] } }] });
const finalState = async (id) => { await until(async () => ["completed", "failed"].includes(await stateOf(id))); return await stateOf(id); };
const replies = {};
for (const ticket of ["586", "590", "592", "600"]) {
  globalThis.currentTicket = ticket;
  const runId = await submitted(ticket);
  await finalState(runId);
  const reply = await asked("continue-run", { runId, commandId: "continue-" + ticket });
  replies[ticket] = reply.kind === "error" ? reply.code : reply.kind;
}
print({ replies, reads });
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines[0], {
      replies: {
        586: "continuation-ticket-closed",
        590: "continuation-pull-request-merged",
        592: "run-continued",
        600: "run-continued",
      },
      reads: [
        "repos/cloving-ai/cloving-ai/issues/586",
        "repos/cloving-ai/cloving-ai/issues/590",
        "repos/cloving-ai/cloving-ai/pulls/690",
        "repos/cloving-ai/cloving-ai/issues/592",
        "repos/cloving-ai/cloving-ai/pulls/692",
      ],
    });
  }));
