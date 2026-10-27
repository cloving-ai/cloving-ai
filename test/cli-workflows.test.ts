import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { withFiles } from "./quality/files-fixture.ts";
import {
  operatorFiles,
  privateFolderFiles,
} from "./workflow-folder-fixture.ts";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { record } from "../src/protocol.ts";
import { lstat, readFile, symlink, writeFile } from "node:fs/promises";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";
import { withHarness } from "./service-fixture.ts";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";

const workflowTest = (name: string, expected = "scenario-result"): string => `
import assert from "node:assert/strict";
import { test } from "node:test";
import { runScenario } from "cloving/workflows/testing";
await test("portable ${name} scenario", async () => {
  const result = await runScenario({
    workflow: new URL("./${name}.ts", import.meta.url).href,
    exportName: "${name}", input: {},
    turn: { kind: "completed", operationId: "turn", receipt: null, result: "scenario-result" },
  });
  assert.equal(result.outcome.result, ${JSON.stringify(expected)}, "workflow assertion sentinel");
});
`;

const entry = resolve("src/cli.ts");

function cli(
  root: string,
  invocation: {
    readonly args: readonly string[];
    readonly entry?: string;
    readonly directory?: string;
    readonly environment?: NodeJS.ProcessEnv;
  },
) {
  return spawnSync(
    process.execPath,
    [invocation.entry ?? entry, "workflows", ...invocation.args],
    {
      cwd: invocation.directory ?? join(root, "repo"),
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        CLOVING_RUNTIME_DIR: join(root, "service/run"),
        ...invocation.environment,
      },
      encoding: "utf8",
      timeout: 30000,
    },
  );
}

await test("CLV-224 list reports folder admission and declarations without a service", () =>
  withFiles(
    {
      ...operatorFiles("project", "develop"),
      ...operatorFiles("project", "site-develop"),
      "repo/.cloving/workflows/site-develop.ts":
        'import { readFile } from "node:fs/promises"; export async function siteDevelop() { "use workflow"; return await readFile("secret"); }',
    },
    (root) => {
      const result = cli(root, {
        args: ["list", "--json"],
        entry: join(candidatePackageRoot, "src/cli.ts"),
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const rows: unknown = JSON.parse(result.stdout);
      assert.ok(Array.isArray(rows));
      const admitted = record(
        rows.find((row) => record(row)?.["workflowId"] === "develop"),
      );
      assert.equal(admitted?.["scope"], "project");
      assert.equal(admitted["admitted"], true);
      assert.deepEqual(admitted["codes"], []);
      assert.equal(
        record(record(admitted["declaration"])?.["workflow"])?.["workflowId"],
        "develop",
      );
      const refused = record(
        rows.find((row) => record(row)?.["workflowId"] === "site-develop"),
      );
      assert.equal(refused?.["admitted"], false);
      assert.ok(
        Array.isArray(refused["codes"]) &&
          refused["codes"].includes("forbidden-import"),
      );
      assert.equal(
        refused["file"],
        join(root, "repo/.cloving/workflows/site-develop.ts"),
      );
    },
  ));

await test("CLV-224 human listing leaves an active service project unchanged", () =>
  withFiles(
    {
      ...operatorFiles("user", "personal"),
      "repo/marker": "",
      "service/project/package.json": "active project sentinel",
      "service/project/artifacts/manifest.json": "active manifest sentinel",
    },
    async (root) => {
      const result = cli(root, {
        args: ["list"],
        entry: join(candidatePackageRoot, "src/cli.ts"),
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /personal \(user, admitted\)/);
      assert.match(result.stdout, /develop-ticket \(bundled, admitted\)/);
      assert.equal(
        await readFile(join(root, "service/project/package.json"), "utf8"),
        "active project sentinel",
      );
      assert.equal(
        await readFile(
          join(root, "service/project/artifacts/manifest.json"),
          "utf8",
        ),
        "active manifest sentinel",
      );
      await assert.rejects(lstat(join(root, "service/run")), {
        code: "ENOENT",
      });
      await withHarness(async (harness) => {
        await harness.start();
        await symlink(harness.runtimeDirectory, join(root, "service/run"));
        const marker = join(harness.projectDirectory, "active-project");
        await writeFile(marker, "live service project");
        const listed = cli(root, {
          args: ["list"],
          entry: join(candidatePackageRoot, "src/cli.ts"),
        });
        assert.equal(listed.status, 0, listed.stdout + listed.stderr);
        assert.equal(await readFile(marker, "utf8"), "live service project");
        assert.equal((await harness.cli(["status"])).status, 0);
      });
    },
  ));

await test("CLV-224 project and user tests import the packaged fake bridge", () =>
  withFiles(
    {
      ...operatorFiles("project", "develop"),
      ...operatorFiles("user", "personal"),
      "repo/.cloving/workflows/develop.test.ts": workflowTest("develop"),
      "config/cloving/workflows/personal.test.ts": workflowTest("personal"),
    },
    (root) => {
      for (const name of ["develop", "personal"]) {
        const result = cli(root, { args: ["test", name] });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(
          result.stdout,
          new RegExp("portable " + name + " scenario"),
        );
      }
    },
  ));

await test("CLV-224 workflow tests use the selected repository as their working directory", () =>
  withFiles(
    {
      ...Object.fromEntries(
        Object.entries(operatorFiles("project", "develop")).map(
          ([file, bytes]) => [file.replace("repo/", "selected/"), bytes],
        ),
      ),
      ...operatorFiles("user", "personal"),
      "repo/marker": "caller",
      "selected/marker": "selected repository",
      "selected/.cloving/workflows/develop.test.ts": workflowTest("develop")
        .replace(
          "import assert",
          'import { readFile } from "node:fs/promises";\nimport assert',
        )
        .replace(
          "const result =",
          'assert.equal(await readFile("marker", "utf8"), "selected repository");\n  const result =',
        )
        .replace(
          'new URL("./develop.ts", import.meta.url).href',
          '".cloving/workflows/develop.ts"',
        ),
      "config/cloving/workflows/personal.test.ts": workflowTest("personal")
        .replace(
          "import assert",
          'import { readFile } from "node:fs/promises";\nimport assert',
        )
        .replace(
          "const result =",
          'assert.equal(await readFile("marker", "utf8"), "selected repository");\n  const result =',
        ),
    },
    (root) => {
      const result = cli(root, {
        args: ["test", "--repository", "../selected"],
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /portable develop scenario/);
      assert.match(result.stdout, /portable personal scenario/);
    },
  ));

await test("CLV-224 workflow test preserves assertion output and the runner failure status", () =>
  withFiles(
    {
      ...operatorFiles("project", "develop"),
      "repo/.cloving/workflows/develop.test.ts": workflowTest(
        "develop",
        "wrong-result",
      ),
    },
    (root) => {
      const result = cli(root, { args: ["test", "develop"] });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(
        result.stdout + result.stderr,
        /workflow assertion sentinel/,
      );
    },
  ));

await test("CLV-224 workflow test distinguishes unknown IDs from missing tests", () =>
  withFiles(
    {
      ...operatorFiles("project", "develop"),
      "repo/.cloving/workflows/develop.declaration.json": JSON.stringify({
        ...candidateDeclaration,
        workflow: {
          ...candidateDeclaration.workflow,
          workflowId: "declared-id",
        },
      }),
    },
    (root) => {
      for (const [name, code] of [
        ["missing", "unknown-workflow"],
        ["declared-id", "workflow-test-missing"],
        ["develop-ticket", "workflow-test-missing"],
      ]) {
        const result = cli(root, { args: ["test", name ?? ""] });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, new RegExp(code ?? ""));
      }
    },
  ));

await test("CLV-224 listing retains folder-level refusal codes", () =>
  withFiles(
    { "repo/marker": "", "config/cloving/marker": "", "elsewhere/marker": "" },
    async (root) => {
      await symlink(
        join(root, "elsewhere"),
        join(root, "config/cloving/workflows"),
      );
      const result = cli(root, { args: ["list", "--json"] });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const rows: unknown = JSON.parse(result.stdout);
      assert.ok(Array.isArray(rows));
      const refused = record(
        rows.find((row) => record(row)?.["scope"] === "user"),
      );
      assert.equal(refused?.["admitted"], false);
      assert.deepEqual(refused["codes"], ["unsafe-workflow-path"]);
      assert.equal(refused["workflowId"], null);
      const human = cli(root, { args: ["list"] });
      assert.equal(human.status, 0, human.stdout + human.stderr);
      assert.match(
        human.stdout,
        /unknown \(user, refused: unsafe-workflow-path\)/,
      );
      assert.match(human.stdout, /develop-ticket \(bundled, admitted\)/);
    },
  ));

await test("CLV-224 workflow command validates options and needs no project for help", () =>
  withFiles({ "repo/marker": "" }, (root) => {
    for (const argumentsList of [
      ["list", "extra"],
      ["test", "--json"],
      ["test", "one", "two"],
      ["list", "--unknown"],
    ])
      assert.equal(cli(root, { args: argumentsList }).status, 2);
    for (const command of ["list", "test"]) {
      const result = cli(root, { args: [command, "--help"] });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /cloving workflows test/);
    }
    const missing = cli(root, { args: ["test"] });
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /workflow-test-missing/);
  }));

await test("CLV-224 listing and test selection preserve workflow filenames with spaces", () =>
  withFiles(
    {
      ...Object.fromEntries(
        Object.entries(operatorFiles("project", "spaced")).map(
          ([file, bytes]) => [file.replace("/spaced.", "/my workflow."), bytes],
        ),
      ),
      "repo/.cloving/workflows/my workflow.test.ts": workflowTest(
        "spaced",
      ).replace("./spaced.ts", "./my workflow.ts"),
    },
    (root) => {
      const listed = cli(root, { args: ["list", "--json"] });
      assert.equal(listed.status, 0, listed.stdout + listed.stderr);
      const rows: unknown = JSON.parse(listed.stdout);
      assert.ok(Array.isArray(rows));
      const workflow = record(
        rows.find((row) => record(row)?.["workflowId"] === "spaced"),
      );
      assert.equal(
        workflow?.["file"],
        join(root, "repo/.cloving/workflows/my workflow.ts"),
      );
      const result = cli(root, { args: ["test", "spaced"] });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /portable spaced scenario/);
    },
  ));

async function privateFolderSetting(root: string): Promise<void> {
  const settings = privateSettingsPath(
    { HOME: root, XDG_CONFIG_HOME: join(root, "config") },
    join(root, "repo"),
  );
  await mkdir(dirname(settings), { recursive: true });
  await writeFile(
    settings,
    JSON.stringify({
      version: 1,
      workflows: { folder: join(root, "private/workflows") },
    }),
  );
}

function userRows(output: string): [string, string][] {
  const rows: unknown = JSON.parse(output);
  assert.ok(Array.isArray(rows));
  return rows
    .map((row) => record(row))
    .filter((row) => row?.["scope"] === "user")
    .map((row): [string, string] => {
      const id = row?.["workflowId"];
      const file = row?.["file"];
      assert.ok(typeof id === "string");
      assert.ok(typeof file === "string");
      return [id, file];
    });
}

await test("CLV-227 list reads the user folder from the private workflows.folder setting", () =>
  withFiles(
    {
      "repo/marker": "",
      "repo/nested/marker": "",
      ...operatorFiles("user", "home"),
      ...privateFolderFiles("own"),
    },
    async (root) => {
      await privateFolderSetting(root);
      spawnSync("git", ["init", "-q", join(root, "repo")]);
      for (const directory of [join(root, "repo"), join(root, "repo/nested")]) {
        const result = cli(root, { args: ["list", "--json"], directory });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.deepEqual(userRows(result.stdout), [
          ["own", join(root, "private/workflows/own.ts")],
        ]);
      }
    },
  ));

await test("CLV-227 a relative CLOVING_WORKFLOW_FOLDER stops the workflows command", () =>
  withFiles({ "repo/marker": "" }, (root) => {
    const result = cli(root, {
      args: ["list", "--json"],
      environment: { CLOVING_WORKFLOW_FOLDER: "relative-workflows" },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(
      result.stderr,
      /CLOVING_WORKFLOW_FOLDER must be an absolute path/,
    );
  }));
