import assert from "node:assert/strict";
import { test } from "node:test";
import { call, field, text, withHarness } from "./service-fixture.ts";
import { view } from "./service-views.ts";

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
      assert.doesNotMatch(
        JSON.stringify(shown),
        /Private body|private-repository|"host"|"ticket"|"input"/,
      );
    }
    await service.close();
  }));
