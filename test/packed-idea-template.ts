import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { manifest } from "./develop-template-fixture.ts";
import {
  configuredIdeaFiles,
  configurations,
} from "./idea-template-options-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { operatorFiles } from "./workflow-folder-fixture.ts";
import { packedCommand } from "./packed-install-fixture.ts";

export const packedIdeaSources = [
  "templates/idea-to-issue/idea-to-issue.test.ts",
  "templates/idea-to-issue/idea-to-issue.ts",
  "templates/idea-to-issue/idea-to-issue/effects.ts",
  "templates/idea-to-issue/idea-to-issue/leave.ts",
  "templates/idea-to-issue/idea-to-issue/next.ts",
  "templates/idea-to-issue/idea-to-issue/post-person.ts",
  "templates/idea-to-issue/idea-to-issue/post.ts",
  "templates/idea-to-issue/idea-to-issue/queue.ts",
  "templates/idea-to-issue/idea-to-issue/review.ts",
  "templates/idea-to-issue/idea-to-issue/scenarios.ts",
  "templates/idea-to-issue/idea-to-issue/turn.ts",
];

export async function packedIdeaTemplate(packageRoot: string): Promise<void> {
  await verifyPackagedIdeaCommands(packageRoot);
  const root = join(packageRoot, "templates/idea-to-issue");
  assert.equal(
    manifest(JSON.parse(await readFile(join(root, "template.json"), "utf8")))
      .name,
    "idea-to-issue",
  );
  for (const selected of configurations) {
    const files = await configuredIdeaFiles(selected, root);
    if (selected.next === "develop")
      Object.assign(files, operatorFiles("project", "develop"));
    await withFiles(files, (directory) => {
      const output = packedCommand(process.execPath, {
        args: [
          join(packageRoot, "dist/src/cli.js"),
          "workflows",
          "test",
          "idea-to-issue",
        ],
        cwd: join(directory, "repo"),
        env: {
          ...process.env,
          NODE_TEST_CONTEXT: undefined,
          XDG_CONFIG_HOME: join(directory, "config"),
        },
      });
      assert.match(output, /selected complete configuration/);
      assert.match(output, /refused post preserves the draft/);
      assert.doesNotMatch(output, /not ok|✖/);
    });
  }
}

export async function verifyPackagedIdeaCommands(
  packageRoot: string,
): Promise<void> {
  await withFiles(operatorFiles("project", "develop"), async (directory) => {
    const repository = join(directory, "repo");
    const invoke = (args: readonly string[]): string =>
      packedCommand(process.execPath, {
        args: [join(packageRoot, "dist/src/cli.js"), ...args],
        cwd: repository,
        env: {
          ...process.env,
          NODE_TEST_CONTEXT: undefined,
          XDG_CONFIG_HOME: join(directory, "config"),
        },
      });
    assert.match(
      invoke(["templates", "list", "--json"]),
      /"name"\s*:\s*"idea-to-issue"/,
    );
    assert.match(
      invoke(["templates", "copy", "idea-to-issue", "--id", "custom-idea"]),
      /cloving workflows test custom-idea/,
    );
    assert.match(
      await readFile(
        join(repository, ".cloving/workflows/custom-idea.declaration.json"),
        "utf8",
      ),
      /"workflowId": "custom-idea"/,
    );
    const tested = invoke(["workflows", "test", "custom-idea"]);
    assert.match(tested, /selected complete configuration/);
    assert.doesNotMatch(tested, /not ok|✖/);
  });
}
