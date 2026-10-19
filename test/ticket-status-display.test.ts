import assert from "node:assert/strict";
import { test } from "node:test";
import { rendered } from "../src/cli/render.ts";
import { watchModel } from "../src/cli/watch-model.ts";
import { completedDetail } from "../src/cli/watch-render.ts";
import { sampleRun } from "./watch-sample.ts";

await test("CLV-123 plain status and the watch page display the merged ticket status", () => {
  for (const ticketStatus of ["complete", "partial"]) {
    const outcome = { kind: "handoff_requested", reason: null, ticketStatus };
    assert.match(
      rendered({ kind: "run-status", run: { outcome } }),
      new RegExp(`Ticket status: ${ticketStatus}`),
    );
    const model = watchModel({
      workflows: ["develop-issue"],
      home: "/fixture",
      client: "cloving",
      updatedAt: "",
      service: "up",
      runs: [
        {
          status: {
            runId: "run-1",
            workflowId: "develop-issue",
            state: "completed",
            outcome,
          },
          events: [],
        },
      ],
      decisions: [],
      turns: [],
      githubRecords: [],
    });
    assert.equal(
      Reflect.get(Object(model.runs[0]), "ticketStatus"),
      ticketStatus,
    );
    assert.match(
      completedDetail({ ...sampleRun(), ...model.runs[0] }),
      new RegExp(`Ticket status: ${ticketStatus}`),
    );
  }
});

await test("CLV-123 status and watch expose failed issue synchronization", () => {
  const outcome = {
    kind: "handoff_requested",
    ticketStatus: "complete",
    issueUpdate: "failed",
  };
  assert.match(
    rendered({ kind: "run-status", run: { outcome } }),
    /Issue status update failed/,
  );
  assert.match(
    completedDetail({ ...sampleRun(), issueUpdate: "failed" }),
    /Issue status update failed/,
  );
});
