import assert from "node:assert/strict";
import { test } from "node:test";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import { folderInput } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { cli } from "./cli-workflows-fixture.ts";
import { templates, packagedEntry } from "./cli-templates-fixture.ts";
import {
  configuredReviewFiles,
  reviewSelections,
} from "./review-template-options-fixture.ts";
import { configuredIdeaFiles } from "./idea-template-options-fixture.ts";

for (const selected of reviewSelections)
  await test(`CLV-200 copied ${selected.post}/${selected.next} admits and passes workflows test`, async () => {
    const files = await configuredReviewFiles(selected);
    if (selected.next === "idea")
      Object.assign(
        files,
        Object.fromEntries(
          Object.entries(
            await configuredIdeaFiles({
              review: "turn",
              post: "privacy",
              next: "nothing",
            }),
          ).filter(([path]) => path.includes("/idea-to-issue")),
        ),
      );
    await withFiles(files, async (directory) => {
      const loaded = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(loaded.refusals, []);
      assert.ok(
        loaded.candidates.some(
          (candidate) => candidate.label === "review-day.ts",
        ),
      );
      const result = cli(directory, {
        entry: packagedEntry,
        args: ["test", "review-day"],
        environment: { NODE_TEST_CONTEXT: undefined },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /approval of proposal two/);
      assert.doesNotMatch(result.stdout, /not ok|✖/);
    });
  });

await test("CLV-200 templates show lists the post and next decisions", () =>
  withFiles({ "repo/marker": "" }, (directory) => {
    const result = templates(directory, ["show", "review-day"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /post: Where should/);
    assert.match(result.stdout, /next: What happens/);
    assert.match(result.stdout, /privacy: .+\(default\)/);
    assert.match(result.stdout, /idea: .+\(default\)/);
  }));
