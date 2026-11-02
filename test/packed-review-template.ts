import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  configuredReviewFiles,
  reviewSelections,
} from "./review-template-options-fixture.ts";
import { configuredIdeaFiles } from "./idea-template-options-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { packedCommand } from "./packed-install-fixture.ts";

export const packedReviewSources = [
  "templates/review-day/review-day.test.ts",
  "templates/review-day/review-day.ts",
  "templates/review-day/review-day/critique.ts",
  "templates/review-day/review-day/decision.ts",
  "templates/review-day/review-day/facts.ts",
  "templates/review-day/review-day/label.ts",
  "templates/review-day/review-day/next.ts",
  "templates/review-day/review-day/post.ts",
  "templates/review-day/review-day/report.ts",
  "templates/review-day/review-day/rules.ts",
  "templates/review-day/review-day/scenarios.ts",
  "templates/review-day/review-day/turn.ts",
];

export async function packedReviewTemplate(packageRoot: string): Promise<void> {
  for (const selected of reviewSelections) {
    const files = await configuredReviewFiles(
      selected,
      join(packageRoot, "templates/review-day"),
    );
    if (selected.next === "idea")
      Object.assign(
        files,
        Object.fromEntries(
          Object.entries(
            await configuredIdeaFiles(
              { review: "turn", post: "privacy", next: "nothing" },
              join(packageRoot, "templates/idea-to-issue"),
            ),
          ).filter(([path]) => path.includes("/idea-to-issue")),
        ),
      );
    await withFiles(files, (directory) => {
      const output = packedCommand(process.execPath, {
        args: [
          join(packageRoot, "dist/src/cli.js"),
          "workflows",
          "test",
          "review-day",
        ],
        cwd: join(directory, "repo"),
        env: {
          ...process.env,
          NODE_TEST_CONTEXT: undefined,
          HOME: directory,
          XDG_CONFIG_HOME: join(directory, "config"),
        },
      });
      assert.match(output, /approval of proposal two/);
      assert.doesNotMatch(output, /not ok|✖/);
    });
  }
  const declaration = await readFile(
    join(packageRoot, "templates/review-day/review-day.declaration.json"),
    "utf8",
  );
  assert.match(declaration, /"everySeconds": 86400/);
}
