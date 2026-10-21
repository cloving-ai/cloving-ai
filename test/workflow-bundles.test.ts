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
    assert.deepEqual((await readdir(input.directory)).sort(), [".history", id]);
  }));

await test("CLV-153 a deleted retained generation cannot be rebuilt from unchanged source", () =>
  withFiles(files, async (root) => {
    const input = settings(root);
    const id = await retainWorkflowBundle(input);
    const directory = join(input.directory, id);
    await rm(directory, { recursive: true });
    await assert.rejects(retainWorkflowBundle(input), {
      message: "pinned-workflow-unavailable",
    });
    await assert.rejects(lstat(directory), { code: "ENOENT" });
    assert.deepEqual(
      await readRetainedWorkflowBundle({ ...input, id }),
      unavailable,
    );
  }));

await test("CLV-153 a missing retention receipt fails closed without rewriting the history", () =>
  withFiles(files, async (root) => {
    const input = settings(root);
    const id = await retainWorkflowBundle(input);
    const receipt = join(input.directory, ".history", id, "bundle.json");
    await rm(receipt);
    await assert.rejects(retainWorkflowBundle(input), {
      message: "pinned-workflow-unavailable",
    });
    await assert.rejects(lstat(receipt), { code: "ENOENT" });
  }));

await test("CLV-153 damaged retention history refuses with the pinned availability code", () =>
  withFiles(files, async (root) => {
    const input = settings(root);
    const id = await retainWorkflowBundle(input);
    const history = join(input.directory, ".history");
    await rm(history, { recursive: true });
    await writeFile(history, "damaged");
    await assert.rejects(retainWorkflowBundle(input), {
      message: "pinned-workflow-unavailable",
    });
    assert.equal(await readFile(history, "utf8"), "damaged");
    assert.equal(
      (await readRetainedWorkflowBundle({ ...input, id })).kind,
      "available",
    );
  }));

await test("CLV-153 inaccessible retention history refuses with the pinned availability code", () =>
  withFiles(files, async (root) => {
    const input = settings(root);
    const id = await retainWorkflowBundle(input);
    const history = join(input.directory, ".history");
    await chmod(history, 0);
    try {
      await assert.rejects(retainWorkflowBundle(input), {
        message: "pinned-workflow-unavailable",
      });
    } finally {
      await chmod(history, 0o700);
    }
    assert.equal(
      (await readRetainedWorkflowBundle({ ...input, id })).kind,
      "available",
    );
  }));

await test("CLV-153 concurrent retention commits one complete generation and leaves no staging directories", () =>
  withFiles(files, async (root) => {
    const input = settings(root);
    const ids = await Promise.all([
      retainWorkflowBundle(input),
      retainWorkflowBundle(input),
    ]);
    assert.equal(ids[0], ids[1]);
    assert.deepEqual((await readdir(input.directory)).sort(), [
      ".history",
      ids[0],
    ]);
    const history = join(input.directory, ".history");
    assert.deepEqual(await readdir(history), [ids[0]]);
    assert.equal((await lstat(history)).mode & 0o077, 0);
    assert.equal(
      (await lstat(join(history, ids[0], "bundle.json"))).mode & 0o077,
      0,
    );
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

await test("CLV-153 existing valid bundles acquire history and reuse immutable receipts", () =>
  withFiles(files, async (root) => {
    const input = settings(root);
    const id = await retainWorkflowBundle(input);
    const history = join(input.directory, ".history");
    await rm(history, { recursive: true });
    assert.equal(await retainWorkflowBundle(input), id);
    const path = join(history, id, "bundle.json");
    const original = await lstat(path);
    const contents = await readFile(path, "utf8");
    assert.equal(
      contents,
      await readFile(join(input.directory, id, "bundle.json"), "utf8"),
    );
    assert.equal(await retainWorkflowBundle(input), id);
    assert.equal((await lstat(path)).ino, original.ino);
    assert.equal(await readFile(path, "utf8"), contents);
    assert.deepEqual(await readdir(history), [id]);
  }));

for (const damage of ["changed", "linked", "pipe", "directory"]) {
  await test(`CLV-153 retention rejects an invalid receipt without substitution: ${damage}`, () =>
    withFiles(files, async (root) => {
      const input = settings(root);
      const id = await retainWorkflowBundle(input);
      const path = join(input.directory, ".history", id, "bundle.json");
      await rm(path);
      switch (damage) {
        case "changed":
          await writeFile(path, "damaged");
          break;
        case "linked":
          await symlink(join(input.directory, id, "bundle.json"), path);
          break;
        case "pipe":
          execFileSync("mkfifo", [path]);
          break;
        case "directory":
          await mkdir(path);
          break;
      }
      const original = await lstat(path);
      await assert.rejects(retainWorkflowBundle(input), {
        message: "pinned-workflow-unavailable",
      });
      assert.equal((await lstat(path)).ino, original.ino);
    }));
}

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
