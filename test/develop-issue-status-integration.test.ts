import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { field, ran } from "./develop-workflow-fixture.ts";
import { completed, statusScenario } from "./develop-issue-fixture.ts";
import { withGithub, type GithubScene } from "./github-worker-fixture.ts";

function scenario(
  scene: GithubScene,
  details: { readonly report: string; readonly run: number },
) {
  const { report, run } = details;
  const given = statusScenario(report);
  return {
    ...given,
    effects: {
      ...given.effects,
      "github open-pr": [
        completed({
          number: run + 6,
          url: "https://github.com/cloving-ai/cloving-ai/pull/7",
          commit: "1".repeat(40),
        }),
      ],
    },
    operationPrefix: `run-${String(run)}`,
    github: {
      repository: scene.repository,
      worktrees: scene.worktrees,
      journal: scene.journal,
      gh: [process.execPath, join(scene.directory, "fake-gh.mjs")],
      environment: {
        FAKE_GH_STATE: join(scene.directory, "gh-state.json"),
        FAKE_GH_ORIGIN: scene.origin,
      },
      privateTexts: ["private-project"],
    },
  };
}

const original = {
  repository: "cloving-ai/cloving-ai",
  number: 63,
  state: "open",
  body: "Original body.\n",
  labels: ["keep", "cloving: in progress"],
};

await test("CLV-123 the workflow and fake GitHub worker close complete work after the merge", () =>
  withGithub(async (scene) => {
    scene.plan({ scores: [], issues: [original] });
    const [line] = await ran([
      scenario(scene, { report: "Checked.\nTicket status: complete", run: 1 }),
    ]);
    assert.equal(field(field(line, "outcome"), "kind"), "handoff_requested");
    assert.equal(scene.state().issues[0]?.["state"], "closed");
    assert.equal(scene.state().issues[0]?.["state_reason"], "completed");
    assert.equal(
      scene.state().issues[0]?.["body"],
      "Original body.\n\n## Cloving status\nCompleted in pull request #7.\n",
    );
    assert.deepEqual(scene.state().issues[0]?.["labels"], ["keep"]);
  }));

await test("CLV-123 workflow partial runs keep history, requeue twice, block the third and redact refused remaining work", () =>
  withGithub(async (scene) => {
    scene.plan({ scores: [], issues: [original] });
    for (const run of [1, 2, 3]) {
      const item =
        run === 3
          ? "Fix /private/project/file."
          : `Remaining item ${String(run)}.`;
      const given = scenario(scene, {
        report: `Changed.\nRemaining:\n- ${item}\nTicket status: partial`,
        run,
      });
      const [line] = await ran([given]);
      assert.equal(field(field(line, "outcome"), "ticketStatus"), "partial");
      const issue = scene.state().issues[0];
      assert.ok(issue);
      assert.equal(issue["state"], "open");
      const remaining = Array.from(
        { length: run },
        (_, index) =>
          `- Pull request #${String(index + 7)}: partial. Remaining: ${index === 2 ? "Remaining work is in the private run report." : `Remaining item ${String(index + 1)}.`}`,
      );
      assert.equal(
        issue["body"],
        `Original body.\n\n## Cloving status\n${remaining.join("\n")}\n`,
      );
      assert.deepEqual(issue["labels"], [
        "keep",
        run === 3 ? "cloving: blocked" : "cloving: ready",
      ]);
    }
  }));
