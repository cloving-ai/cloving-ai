import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runScenario } from "../src/testing.ts";
import { withGithub, statusBody } from "./github-worker-fixture.ts";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import {
  partialComposition,
  templateTurnFiles,
  turnDeclaration,
} from "./develop-template-turn-fixture.ts";
import { folderInput } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

const template = fileURLToPath(
  new URL("../templates/develop", import.meta.url),
);

await test("CLV-221 queued partial requests requeue twice and block the third merged run", () =>
  withGithub(async (scene) => {
    const body = "Preserve the ticket requirements.\n";
    scene.plan({
      scores: [],
      issues: [
        {
          repository: "acme/demo",
          number: 42,
          state: "open",
          body,
          labels: ["keep", "cloving: in progress"],
        },
      ],
    });
    const worker = scene.worker({ privateTexts: ["private-project"] });
    const history = [];
    for (const pullRequest of [7, 8, 9]) {
      const remaining = [`Finish after pull request ${String(pullRequest)}.`];
      const scenario = await runScenario({
        workflow: `${template}/develop/queue-partial.ts`,
        exportName: "queuePartial",
        input: {
          cycleId: "run-1",
          round: 1,
          issue: { owner: "acme", repository: "demo", number: 42 },
          pullRequest,
          remaining,
        },
      });
      assert.equal(scenario.requests.length, 1);
      const request = scenario.requests[0];
      assert.ok(request && request[0] === "effect");
      const payload: unknown = JSON.parse(request[1].payload);
      assert.ok(typeof payload === "object" && payload !== null);
      const report = await scene.perform(worker, {
        method: request[1].method,
        payload,
      });
      assert.equal(report.outcome, "completed", JSON.stringify(report));
      history.push({ pullRequest, remaining });
      assert.equal(
        scene.state().issues[0]?.["body"],
        statusBody(body, { partialRuns: history }),
      );
      assert.deepEqual(scene.state().issues[0]?.["labels"], [
        "keep",
        pullRequest === 9 ? "cloving: blocked" : "cloving: ready",
      ]);
    }
  }));

for (const option of ["queue", "person"] as const)
  await test(`CLV-221 the ${option} partial helper passes folder admission`, async () => {
    await withFiles(
      {
        ...(await templateTurnFiles(template)),
        ...partialComposition(option),
      },
      async (directory) => {
        const loaded = await loadWorkflowFolders(folderInput(directory));
        assert.deepEqual(loaded.refusals, []);
        assert.equal(loaded.candidates.length, 1);
        assert.deepEqual(Object.keys(loaded.candidates[0]?.helpers ?? {}), [
          option === "queue"
            ? "develop/queue-partial.ts"
            : "develop/partial.ts",
        ]);
      },
    );
  });

for (const input of ["ticket", "prompt"] as const)
  await test(`CLV-221 the template turn helper passes folder admission with ${input} input`, async () => {
    await withFiles(
      {
        ...(await templateTurnFiles(template)),
        "repo/.cloving/workflows/develop.declaration.json":
          turnDeclaration(input),
      },
      async (directory) => {
        const loaded = await loadWorkflowFolders(folderInput(directory));
        assert.deepEqual(loaded.refusals, []);
        assert.equal(loaded.candidates.length, 1);
        const candidate = loaded.candidates[0];
        assert.ok(candidate);
        assert.equal(candidate.baseName, "develop");
        assert.deepEqual(Object.keys(candidate.helpers), ["develop/turn.ts"]);
      },
    );
  });
