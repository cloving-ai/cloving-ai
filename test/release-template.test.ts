import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { manifest } from "./develop-template-fixture.ts";
import { isCandidateDeclaration } from "../src/workflow-candidate.ts";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import { folderInput } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { cli } from "./cli-workflows-fixture.ts";
import { packagedEntry } from "./cli-templates-fixture.ts";
import {
  configuredReleaseFiles,
  releaseSelections,
} from "./release-template-options-fixture.ts";

const readmeRequirements = [
  "private workflow folder",
  "CLOVING_COMMANDS",
  "push-tag",
  "release-status",
  "release-pulls",
  '{ "version": "1.7.0", "tag": "v1.7.0", "pullRequest": 650 }',
  '{ "tag": "v1.7.0", "commit": ',
  '{ "check": "pulls", "pullRequests": [641, 643] }',
  '"check": "release"',
  '{"ready": false}',
  '"state": "published"',
  '"state": "failed", "output": ',
  "no secret and no publish credential",
  "GH_CONFIG_DIR",
  "Publish v1.7.0?",
  "handoff_requested",
  "default branch",
];

await test("CLV-304 release declares the accept and publish choices, the two operator commands and their waits", async () => {
  const root = new URL("../templates/release/", import.meta.url);
  const document = manifest(
    JSON.parse(await readFile(new URL("template.json", root), "utf8")),
  );
  assert.equal(document.name, "release");
  assert.deepEqual(
    document.points.map((point) => [
      point.id,
      point.options.map((option) => [option.id, option.label]),
    ]),
    [
      [
        "accept",
        [
          ["greptile", "Greptile at 5/5"],
          ["person", "A person"],
          ["turn", "A review turn"],
        ],
      ],
      [
        "publish",
        [
          ["person", "A person approves"],
          ["merge", "Publish after the merge"],
        ],
      ],
    ],
  );
  const declaration: unknown = JSON.parse(
    await readFile(new URL("release.declaration.json", root), "utf8"),
  );
  assert.ok(isCandidateDeclaration(declaration));
  const { workflow } = declaration;
  assert.deepEqual(workflow.input.fields, {
    version: { type: "string" },
    pullRequests: { type: "string", optional: true },
  });
  assert.deepEqual(workflow.capabilities, ["claude", "command", "github"]);
  assert.deepEqual(workflow.commands, ["push-tag", "release-status"]);
  assert.deepEqual(workflow.commandWaits, {
    "release-pulls": {
      command: "release-status",
      maximumWaitSeconds: 604800,
      pollEverySeconds: 300,
    },
    "release-status": {
      command: "release-status",
      maximumWaitSeconds: 7200,
      pollEverySeconds: 60,
    },
  });
  assert.deepEqual(declaration.methods, {
    claude: ["run-turn"],
    command: ["run:push-tag"],
    github: ["prepare", "open-pr", "wait-review", "merge"],
  });
});

await test("CLV-304 the release README names the two operator commands, their input and output, and the publish rules", async () => {
  const readme = await readFile(
    new URL("../templates/release/README.md", import.meta.url),
    "utf8",
  );
  for (const requirement of readmeRequirements)
    assert.ok(readme.includes(requirement), requirement);
});

for (const selection of releaseSelections)
  await test(`CLV-304 copied release with ${selection.accept}/${selection.publish} admits and passes workflows test`, async () => {
    const files = await configuredReleaseFiles(selection);
    await withFiles(files, async (directory) => {
      const loaded = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(loaded.refusals, []);
      const result = cli(directory, {
        entry: packagedEntry,
        args: ["test", "release"],
        environment: { NODE_TEST_CONTEXT: undefined },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /a published status ends with the tag/);
      assert.match(result.stdout, /a denied publish decision pushes no tag/);
      assert.doesNotMatch(result.stdout, /not ok|✖/);
    });
  });
