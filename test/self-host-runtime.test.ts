import assert from "node:assert/strict";
import filesystem from "node:fs/promises";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { runtimeDirectory } from "../src/cli/runtime-directory.ts";
import { adoptRuntimeDirectory } from "../tools/self-host-runtime.ts";
import { retainWorkflowBundle } from "../tools/workflow-bundles.ts";
import { projectFiles } from "./cli-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

const files = {
  ...projectFiles,
  "project with spaces/package.json": "{}",
  "project with spaces/declarations.json": "[]",
  "project with spaces/dependencies.json": "{}",
  "project with spaces/workflows/fixture.ts": "export const fixture = 1;",
  "repository/file": "",
  "other/file": "",
};

function selection(root: string) {
  const repository = join(root, "repository");
  const environment = {
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "state"),
  };
  const runtime = runtimeDirectory(environment, repository);
  assert.ok(runtime);
  return {
    environment,
    repository,
    runtime,
    legacyRuntime: join(root, "state/cloving/run"),
    adoptionRecord: join(
      root,
      "state/cloving/adopted-runtime",
      `${basename(dirname(runtime))}.json`,
    ),
  };
}

function retain(root: string, repository: string) {
  return retainWorkflowBundle({
    project: join(root, "project with spaces"),
    repository,
    directory: join(root, "state/cloving/workflow-bundles"),
  });
}

async function prepareBundles(root: string, contents: string): Promise<void> {
  if (["foreign", "mixed"].includes(contents))
    await retain(root, join(root, "other"));
  if (!["mixed", "damaged", "unreadable"].includes(contents)) return;
  const id = await retain(root, join(root, "repository"));
  const bundle = join(root, "state/cloving/workflow-bundles", id);
  if (contents === "damaged")
    await writeFile(join(bundle, "artifacts/flow.mjs"), "damaged");
  if (contents === "unreadable") await chmod(join(bundle, "bundle.json"), 0);
}

await test("CLV-204 start adopts only its retained bundles and clients reuse the record", () =>
  withFiles(files, async (root) => {
    const input = selection(root);
    await retain(root, input.repository);
    await writeFile(
      join(root, "project with spaces/declarations.json"),
      "[{}]",
    );
    await retain(root, input.repository);
    const result = await adoptRuntimeDirectory(input);
    assert.equal(result.runtime, input.legacyRuntime);
    assert.deepEqual(JSON.parse(await readFile(input.adoptionRecord, "utf8")), {
      schemaVersion: 1,
      repository: input.repository,
      runtimeDirectory: input.legacyRuntime,
    });
    assert.equal(
      runtimeDirectory(input.environment, input.repository),
      input.legacyRuntime,
    );
    assert.equal(
      runtimeDirectory(
        { ...input.environment, CLOVING_RUNTIME_DIR: "/explicit" },
        input.repository,
      ),
      "/explicit",
    );
    await assert.rejects(readdir(join(root, "state/cloving/projects")), {
      code: "ENOENT",
    });
    await rm(join(root, "state/cloving/workflow-bundles"), { recursive: true });
    assert.equal(
      runtimeDirectory(input.environment, input.repository),
      input.legacyRuntime,
    );
  }));

await test("CLV-204 clients only see complete adoption records", () =>
  withFiles(files, async (root) => {
    const input = selection(root);
    await retain(root, input.repository);
    const original = filesystem.writeFile;
    let observed = false;
    filesystem.writeFile = async (path, contents) => {
      await original(path, "{");
      observed = true;
      assert.equal(
        runtimeDirectory(input.environment, input.repository),
        input.runtime,
      );
      await original(path, contents);
    };
    syncBuiltinESMExports();
    try {
      assert.equal(
        (await adoptRuntimeDirectory(input)).runtime,
        input.legacyRuntime,
      );
      assert.equal(observed, true);
      assert.equal(
        runtimeDirectory(input.environment, input.repository),
        input.legacyRuntime,
      );
      assert.deepEqual(await readdir(dirname(input.adoptionRecord)), [
        basename(input.adoptionRecord),
      ]);
    } finally {
      filesystem.writeFile = original;
      syncBuiltinESMExports();
    }
  }));

await test("CLV-204 failed adoption writes leave no published record", () =>
  withFiles(files, async (root) => {
    const input = selection(root);
    await retain(root, input.repository);
    const original = filesystem.writeFile;
    filesystem.writeFile = async (path) => {
      await original(path, "{");
      throw new Error("interrupted-write");
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(adoptRuntimeDirectory(input), /interrupted-write/);
      assert.equal(
        runtimeDirectory(input.environment, input.repository),
        input.runtime,
      );
      assert.deepEqual(await readdir(dirname(input.adoptionRecord)), []);
    } finally {
      filesystem.writeFile = original;
      syncBuiltinESMExports();
    }
    assert.equal(
      (await adoptRuntimeDirectory(input)).runtime,
      input.legacyRuntime,
    );
  }));

await test("CLV-204 adoption cannot replace an existing record", () =>
  withFiles(files, async (root) => {
    const input = selection(root);
    await retain(root, input.repository);
    await mkdir(dirname(input.adoptionRecord), { recursive: true });
    const existing = JSON.stringify({
      schemaVersion: 1,
      repository: input.repository,
      runtimeDirectory: join(root, "existing/run"),
    });
    await writeFile(input.adoptionRecord, existing);
    await assert.rejects(adoptRuntimeDirectory(input), { code: "EEXIST" });
    assert.equal(await readFile(input.adoptionRecord, "utf8"), existing);
    assert.deepEqual(await readdir(dirname(input.adoptionRecord)), [
      basename(input.adoptionRecord),
    ]);
  }));

for (const contents of ["empty", "foreign", "mixed", "damaged", "unreadable"]) {
  await test(`CLV-204 legacy ${contents} bundles prevent adoption and produce a note`, () =>
    withFiles(files, async (root) => {
      const input = selection(root);
      await prepareBundles(root, contents);
      try {
        const result = await adoptRuntimeDirectory(input);
        assert.equal(result.runtime, input.runtime);
        assert.ok(result.note.includes(input.legacyRuntime));
        await assert.rejects(readFile(input.adoptionRecord), {
          code: "ENOENT",
        });
      } finally {
        const bundles = join(root, "state/cloving/workflow-bundles");
        for (const id of await readdir(bundles).catch(() => []))
          if (id !== ".history")
            await chmod(join(bundles, id, "bundle.json"), 0o600);
      }
    }));
}

await test("CLV-204 an explicit runtime bypasses adoption without reading legacy bundles", () =>
  withFiles(files, async (root) => {
    const input = selection(root);
    await mkdir(dirname(input.adoptionRecord), { recursive: true });
    await writeFile(input.adoptionRecord, "damaged");
    const runtime = join(root, "explicit/run");
    assert.deepEqual(
      await adoptRuntimeDirectory({
        ...input,
        runtime,
        legacyRuntime: undefined,
        adoptionRecord: undefined,
      }),
      { runtime, note: "" },
    );
  }));
