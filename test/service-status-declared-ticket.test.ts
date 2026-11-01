import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkflowRegistration } from "../src/service/service.ts";
import { call, field, text, withHarness } from "./service-fixture.ts";
import { view } from "./service-views.ts";

const cases = [
  {
    ticket: {
      id: "510",
      text: "# CLV-261: Run the daemon tests on a declared workflow\n\nGitHub issue: cloving-ai/cloving-ai#510 (open)",
    },
    ticketId: "510",
    issueIdentity: {
      owner: "cloving-ai",
      repository: "cloving-ai",
      number: 510,
    },
    title: "CLV-261: Run the daemon tests on a declared workflow",
  },
  {
    ticket: { id: "7", text: "No heading" },
    ticketId: "7",
    issueIdentity: null,
    title: "Cloving task task-0123456789ab",
  },
  {
    ticket: { id: 7, text: 7 },
    ticketId: null,
    title: null,
    issueIdentity: undefined,
  },
  {
    ticket: "plain text",
    ticketId: null,
    title: null,
    issueIdentity: undefined,
  },
  {
    ticket: { id: "8", text: "No heading" },
    ticketId: "8",
    title: "Cloving task task-0123456789ab",
    issueIdentity: null,
  },
];

function declaredWorkflow(
  registration: WorkflowRegistration,
  declared: {
    readonly workflowId: string;
    readonly ticket: (typeof cases)[number]["ticket"];
  },
): WorkflowRegistration {
  return {
    ...registration,
    workflowId: declared.workflowId,
    resolver: {
      ...registration.resolver,
      resolve: () =>
        Promise.resolve({
          kind: "resolved" as const,
          input: {
            cycleId: "task-0123456789ab",
            repository: "/repository",
            input: { ticket: declared.ticket },
          },
        }),
    },
  };
}

await test("CLV-267 status shows the ticket ID and title of a declared workflow input", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: [
        ...cases.map((entry, index) =>
          declaredWorkflow(harness.registration, {
            workflowId:
              index === cases.length - 1
                ? "develop-prompt"
                : `declared-${String(index)}`,
            ticket: entry.ticket,
          }),
        ),
        harness.registration,
      ],
    });
    for (const [index, entry] of cases.entries()) {
      const reply = await call(harness, {
        operation: "run",
        parameters: {
          workflowId:
            index === cases.length - 1
              ? "develop-prompt"
              : `declared-${String(index)}`,
          source: "prompt",
          submission: { prompt: "declared" },
          commandId: `declared-ticket-${String(index)}`,
        },
      });
      const shown = await view(harness, text(reply, "runId"));
      assert.equal(field(shown, "ticketId"), entry.ticketId, String(index));
      assert.equal(field(shown, "title"), entry.title, String(index));
      assert.deepEqual(field(shown, "issueIdentity"), entry.issueIdentity);
    }
    await service.close();
  }));
