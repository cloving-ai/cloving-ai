import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  readRetainedWorkflowBundle,
  retainWorkflowBundle,
} from "../tools/workflow-bundles.ts";
import { withFiles } from "./quality/files-fixture.ts";

const files = {
  "repo/marker": "",
  "other/marker": "",
  "project/package.json": '{"name":"synthetic","type":"module"}',
  "project/declarations.json": "[]",
  "project/dependencies.json": "{}",
  "project/fixture.workflow.json": '{"artifacts":"artifacts"}',
  "project/workflows/fixture.ts":
    'export async function fixture() { "use workflow"; return 1; }',
  "project/artifacts/flow.mjs": "compiled flow",
  "project/artifacts/steps.mjs": "compiled steps",
  "project/artifacts/client.mjs": "compiled client",
  "project/artifacts/manifest.json": "{}",
  "project/artifacts/flow.mjs.__wf_tmp.js.debug.json": "{}",
  "project/artifacts/steps.mjs.debug.json": "{}",
};

function settings(root: string) {
  return {
    directory: join(root, "bundles"),
    project: join(root, "project"),
    repository: join(root, "repo"),
  };
}

const unavailable = {
  kind: "unavailable",
  code: "pinned-workflow-unavailable",
};

await test("CLV-153 retained lookup validates the entire inventory and repository binding", () =>
  withFiles(files, async (root) => {
    const input = settings(root);
    const id = await retainWorkflowBundle(input);
    const lookup = { ...input, id };
    const directory = join(input.directory, id);
    assert.deepEqual(await readRetainedWorkflowBundle(lookup), {
      kind: "available",
      directory,
    });
    assert.deepEqual(
      await readRetainedWorkflowBundle({
        ...lookup,
        repository: join(root, "other"),
      }),
      unavailable,
    );
    const path = join(directory, "artifacts/steps.mjs");
    await writeFile(path, "damaged");
    assert.deepEqual(await readRetainedWorkflowBundle(lookup), unavailable);
    await writeFile(path, files["project/artifacts/steps.mjs"]);
    await rm(join(directory, "workflows/fixture.ts"));
    assert.deepEqual(await readRetainedWorkflowBundle(lookup), unavailable);
  }));

await test("CLV-153 retaining an existing damaged generation refuses without repair or substitution", () =>
  withFiles(files, async (root) => {
    const input = settings(root);
    const id = await retainWorkflowBundle(input);
    const path = join(input.directory, id, "artifacts/flow.mjs");
    await writeFile(path, "damaged");
    await assert.rejects(retainWorkflowBundle(input), {
      message: "pinned-workflow-unavailable",
    });
    assert.equal(await readFile(path, "utf8"), "damaged");
    assert.deepEqual(await readdir(input.directory), [id]);
  }));

await test("CLV-153 concurrent retention commits one complete generation and leaves no staging directories", () =>
  withFiles(files, async (root) => {
    const input = settings(root);
    const ids = await Promise.all([
      retainWorkflowBundle(input),
      retainWorkflowBundle(input),
    ]);
    assert.equal(ids[0], ids[1]);
    assert.deepEqual(await readdir(input.directory), [ids[0]]);
    assert.equal((await lstat(input.directory)).mode & 0o077, 0);
    assert.equal(
      (await lstat(join(input.directory, ids[0], "bundle.json"))).mode & 0o077,
      0,
    );
    assert.equal(
      (await readRetainedWorkflowBundle({ ...input, id: ids[0] })).kind,
      "available",
    );
  }));

await test("CLV-153 an incomplete compiler bundle never becomes a retained generation", () =>
  withFiles(files, async (root) => {
    const input = settings(root);
    await rm(join(input.project, "artifacts/client.mjs"));
    await assert.rejects(retainWorkflowBundle(input), {
      message: "incomplete-workflow-bundle",
    });
    await assert.rejects(readdir(input.directory), { code: "ENOENT" });
  }));

await test("CLV-153 a damaged bundle record cannot hang validation on a named pipe", () =>
  withFiles(files, async (root) => {
    const input = settings(root);
    const id = await retainWorkflowBundle(input);
    const path = join(input.directory, id, "bundle.json");
    await rm(path);
    execFileSync("mkfifo", [path]);
    const module = pathToFileURL(
      join(import.meta.dirname, "../tools/workflow-bundles.ts"),
    ).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import { readRetainedWorkflowBundle } from ${JSON.stringify(module)};
process.stdout.write(JSON.stringify(await readRetainedWorkflowBundle(${JSON.stringify({ ...input, id })})));`,
      ],
      { encoding: "utf8", timeout: 2000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const output: unknown = JSON.parse(result.stdout);
    assert.deepEqual(output, unavailable);
  }));

for (const name of [
  "bundle.json",
  "artifacts/manifest.json",
  "fixture.workflow.json",
  "declarations.json",
  "dependencies.json",
]) {
  await test(`CLV-153 changed retained metadata is unavailable: ${name}`, () =>
    withFiles(files, async (root) => {
      const input = settings(root);
      const id = await retainWorkflowBundle(input);
      await writeFile(join(input.directory, id, name), "damaged");
      assert.deepEqual(
        await readRetainedWorkflowBundle({ ...input, id }),
        unavailable,
      );
    }));
}

await test("CLV-153 lookup rejects missing generations, unsafe IDs, extra artifacts and linked files", () =>
  withFiles(files, async (root) => {
    const input = settings(root);
    const id = await retainWorkflowBundle(input);
    const directory = join(input.directory, id);
    for (const id of ["../project", "0".repeat(64)])
      assert.deepEqual(
        await readRetainedWorkflowBundle({ ...input, id }),
        unavailable,
      );
    await writeFile(join(directory, "artifacts/extra.mjs"), "extra");
    assert.deepEqual(
      await readRetainedWorkflowBundle({ ...input, id }),
      unavailable,
    );
    await rm(join(directory, "artifacts/extra.mjs"));
    const path = join(directory, "artifacts/flow.mjs");
    await rm(path);
    await symlink(join(input.project, "artifacts/flow.mjs"), path);
    assert.deepEqual(
      await readRetainedWorkflowBundle({ ...input, id }),
      unavailable,
    );
    await assert.rejects(
      retainWorkflowBundle({ ...input, project: directory }),
    );
  }));

await test("CLV-153 lookup rejects unreadable records and linked directories while accepting repository aliases", () =>
  withFiles(files, async (root) => {
    const input = settings(root);
    const id = await retainWorkflowBundle(input);
    const directory = join(input.directory, id);
    const path = join(directory, "bundle.json");
    const alias = join(root, "alias");
    await symlink(input.repository, alias);
    assert.equal(
      (await readRetainedWorkflowBundle({ ...input, repository: alias, id }))
        .kind,
      "available",
    );
    await chmod(path, 0);
    assert.deepEqual(
      await readRetainedWorkflowBundle({ ...input, id }),
      unavailable,
    );
    await chmod(path, 0o600);
    await rm(path);
    await mkdir(path);
    assert.deepEqual(
      await readRetainedWorkflowBundle({ ...input, id }),
      unavailable,
    );
    await rm(directory, { recursive: true });
    await symlink(input.project, directory);
    assert.deepEqual(
      await readRetainedWorkflowBundle({ ...input, id }),
      unavailable,
    );
  }));
