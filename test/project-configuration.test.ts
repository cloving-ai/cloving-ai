import { configurationEntries } from "../src/configuration-display.ts";
import { resolveSettings } from "../src/project-settings.ts";
import { queuePlan } from "../tools/self-host-queue.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import {
  projectConfiguration,
  projectRoot,
} from "../tools/project-configuration.ts";
import { withFiles } from "./quality/files-fixture.ts";

function settingsEnvironment(root: string): NodeJS.ProcessEnv {
  return { HOME: root, XDG_CONFIG_HOME: join(root, "config") };
}

await test("CLV-227 project configuration reads the project and private settings files", () =>
  withFiles(
    {
      "repo/.cloving/config.json": JSON.stringify({
        version: 1,
        checks: { beforeMerge: ["npm", "test"] },
      }),
    },
    async (root) => {
      const environment = settingsEnvironment(root);
      const repository = join(root, "repo");
      const settings = privateSettingsPath(environment, repository);
      await mkdir(dirname(settings), { recursive: true });
      await writeFile(
        settings,
        JSON.stringify({ version: 1, workflows: { folder: "/srv/workflows" } }),
      );
      const resolved = await projectConfiguration(repository, environment);
      assert.equal(
        resolved.environment["CLOVING_CHECK_COMMAND"],
        '["npm","test"]',
      );
      assert.equal(
        resolved.environment["CLOVING_WORKFLOW_FOLDER"],
        "/srv/workflows",
      );
    },
  ));

await test("CLV-227 project configuration treats missing files as empty and refuses unreadable ones", () =>
  withFiles({ "repo/marker": "" }, async (root) => {
    const environment = settingsEnvironment(root);
    const repository = join(root, "repo");
    const empty = await projectConfiguration(repository, environment);
    assert.equal(empty.environment["CLOVING_WORKFLOW_FOLDER"], undefined);
    await mkdir(privateSettingsPath(environment, repository), {
      recursive: true,
    });
    await assert.rejects(
      projectConfiguration(repository, environment),
      /unreadable-config-file: private/,
    );
  }));

await test("CLV-227 the project root is the git top level, or the folder itself outside git", () =>
  withFiles({ "plain/marker": "", "repo/nested/marker": "" }, async (root) => {
    assert.equal(
      await projectRoot(join(root, "plain")),
      await realpath(join(root, "plain")),
    );
    execFileSync("git", ["init", "-q", join(root, "repo")]);
    assert.equal(
      await projectRoot(join(root, "repo/nested")),
      await realpath(join(root, "repo")),
    );
  }));

await test("CLV-361 a private lane override preserves project queue fields and other queues after restart", () => {
  const project = {
    version: 1,
    queues: {
      develop: { everySeconds: 300, lanes: 4, workingLanes: 2 },
      other: { state: "off", lanes: 3 },
    },
  };
  const privateFile = { version: 1, queues: { develop: { lanes: 9 } } };
  const resolved = resolveSettings(
    { CLOVING_QUEUE_LANES: "8" },
    { project: JSON.stringify(project), private: JSON.stringify(privateFile) },
  );
  assert.deepEqual(
    JSON.parse(resolved.environment["CLOVING_QUEUES"] ?? "null"),
    {
      develop: { everySeconds: 300, lanes: 9, workingLanes: 2 },
      other: { state: "off", lanes: 3 },
    },
  );
  const [entry] = configurationEntries({
    project: JSON.stringify(project),
    private: JSON.stringify(privateFile),
    environment: {},
    field: "queues",
  });
  assert.deepEqual(
    entry?.value,
    JSON.parse(resolved.environment["CLOVING_QUEUES"] ?? "null"),
  );
  const plan = queuePlan(
    {
      ...resolved.environment,
      CLOVING_NEXT_COMMAND: '["next"]',
      CLOVING_TICKET_COMMAND: '["ticket"]',
    },
    {
      declarations: [{ workflowId: "develop", queue: true }],
      sources: resolved.sources,
    },
  );
  assert.equal(plan.kind, "on");
  assert.deepEqual(plan.values, {
    everySeconds: { value: 300, source: "queues setting (project file)" },
    lanes: { value: 9, source: "queues setting (private file)" },
    workingLanes: { value: 2, source: "queues setting (project file)" },
  });
});
