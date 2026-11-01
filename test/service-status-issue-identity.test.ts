import assert from "node:assert/strict";
import { test } from "node:test";
import {
  call,
  field,
  items,
  parsed,
  startedRun,
  text,
  withHarness,
} from "./service-fixture.ts";
import { view } from "./service-views.ts";

const legacyInput = {
  cycleId: "legacy-issue",
  ticketId: "63",
  ticket: "# Old issue\nGitHub issue: example/project#63 (closed)",
};

await test("CLV-262 status retains completed bundled runs after their registrations are removed", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: [
        {
          ...harness.registration,
          workflowId: "develop-issue",
          resolver: {
            ...harness.registration.resolver,
            resolve: () =>
              Promise.resolve({
                kind: "resolved",
                input: legacyInput,
              }),
          },
        },
      ],
    });
    const runId = await startedRun(harness, {
      service,
      workflowId: "develop-issue",
      commandId: "legacy",
    });
    assert.equal(
      (
        await service.worker.submit({
          kind: "complete-run",
          runId,
          commandId: "legacy-complete",
          expectedRevision: 2,
          outcome: "handoff_requested",
        })
      ).kind,
      "accepted",
    );
    await service.close();
    const restarted = await harness.start({ workflows: [] });
    const shownRuns: unknown[] = [];
    for (const argumentsList of [["status"], ["status", runId]]) {
      const result = await harness.cli([...argumentsList, "--json"]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const reply = parsed(result);
      const shown =
        argumentsList.length === 1 ? items(reply["runs"])[0] : reply["run"];
      assert.equal(field(shown, "runId"), runId);
      assert.equal(field(shown, "workflowId"), "develop-issue");
      assert.equal(field(shown, "state"), "completed");
      shownRuns.push(shown);
    }
    const shown = shownRuns[1];
    assert.equal(field(shown, "ticketId"), "63");
    assert.equal(field(shown, "title"), "Old issue");
    assert.deepEqual(field(shown, "issueIdentity"), {
      owner: "example",
      repository: "project",
      number: 63,
    });
    await restarted.close();
  }));

await test("CLV-129 single issue status exposes only one valid stored issue marker without establishing a host", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: [
        {
          ...harness.registration,
          workflowId: "develop-issue",
          resolver: {
            ...harness.registration.resolver,
            resolve: (request) =>
              Promise.resolve({
                kind: "resolved" as const,
                input: {
                  ticket: `# Synthetic issue\n${String(request.submission["prompt"])}\nPrivate body`,
                  repository: "/fixture/private-repository",
                },
              }),
          },
        },
      ],
    });
    const valid = { owner: "fixture", repository: "demo", number: 7 };
    const cases = [
      ["GitHub issue: Fixture/Demo#7 (open)", valid],
      ["GitHub issue: fixture/demo#7\r\nDetails", valid],
      ["GitHub issue: fixture/demo#0", null],
      ["GitHub issue: fixture/demo#9007199254740992", null],
      ["GitHub issue: fixture/demo#7 trailing", null],
      ["GitHub issue: https://other.example/fixture/demo#7", null],
      ["GitHub issue: fixture/demo#7\nGitHub issue: fixture/demo#7", null],
      ["GitHub issue: fixture/demo#7\nGitHub issue: invalid", null],
      ["No marker", null],
    ] as const;
    for (const [index, [prompt, expected]] of cases.entries()) {
      const reply = await call(harness, {
        operation: "run",
        parameters: {
          workflowId: "develop-issue",
          source: "prompt",
          submission: { prompt },
          commandId: `issue-marker-${String(index)}`,
        },
      });
      const shown = await view(harness, text(reply, "runId"));
      assert.deepEqual(field(shown, "issueIdentity"), expected, prompt);
      assert.deepEqual(field(shown, "input"), { prompt });
      assert.doesNotMatch(
        JSON.stringify(shown),
        /Private body|private-repository|"host"|"ticket"/,
      );
    }
    await service.close();
  }));
