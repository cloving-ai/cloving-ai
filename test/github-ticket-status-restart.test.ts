import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { located } from "../src/daemon/operation-journal.ts";
import { githubIntent, withGithub } from "./github-worker-fixture.ts";
import { until } from "./claude-worker-fixture.ts";

const payload = {
  owner: "acme",
  repository: "demo",
  number: 42,
  pullRequest: 7,
  remaining: ["Test recovery."],
};
const options = { privateTexts: ["private-project"] };

for (const method of ["partial-issue", "close-issue"])
  await test(`CLV-123 restart after merge writes ${method} once and reconciles a lost write receipt`, () =>
    withGithub(async (scene) => {
      scene.plan({
        scores: [],
        issues: [
          {
            repository: "acme/demo",
            number: 42,
            state: "open",
            body: "Original.",
            labels: ["cloving: in progress"],
          },
        ],
      });
      const operationId = "post-merge-status";
      const folder = located(scene.journal, operationId).folder;
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "started.json"),
        JSON.stringify({
          ...githubIntent({ operationId, method }),
          payloadText: JSON.stringify(payload),
        }),
      );
      const first = scene.unscanned(options);
      await first.scan();
      await until(() =>
        scene.reports.some((report) => report.operationId === operationId),
      );
      await first.close();
      assert.equal(scene.reports.at(0)?.outcome, "completed");
      rmSync(join(folder, "result.json"));
      scene.reports.length = 0;
      const second = scene.unscanned(options);
      await second.scan();
      await until(() =>
        scene.reports.some((report) => report.operationId === operationId),
      );
      await second.close();
      assert.equal(scene.reports.at(0)?.outcome, "completed");
      assert.equal(
        scene.state().calls.filter((call) => call.includes("PATCH")).length,
        1,
      );
      assert.equal(
        String(scene.state().issues[0]?.["body"]).match(/pull request #7/gi)
          ?.length,
        1,
      );
      assert.deepEqual(
        scene.state().issues[0]?.["labels"],
        method === "partial-issue" ? ["cloving: ready"] : [],
      );
      const calls = scene.state().calls;
      const third = scene.unscanned(options);
      await third.scan();
      assert.deepEqual(scene.state().calls, calls);
    }));
