import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { retainWorkflowBundle } from "../tools/workflow-bundles.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const product = join(import.meta.dirname, "..");

const folders = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];

const sources = Object.fromEntries(
  folders.flatMap((folder, index) =>
    ["start", "finish"].map((name, offset) => {
      const workflow = `workflow${String(index * 2 + offset)}`;
      return [
        `workflows/${folder}/${name}.ts`,
        `export async function ${workflow}Step() {
  "use step";
  return ${JSON.stringify(`${folder}-${name}`)};
}
export async function ${workflow}() {
  "use workflow";
  return await ${workflow}Step();
}
`,
      ];
    }),
  ),
);

function compile(project: string): void {
  execFileSync(
    process.execPath,
    [join(product, "tools/compile-workflows.ts"), "workflows", "artifacts"],
    { cwd: project, stdio: "pipe", timeout: testMilliseconds(30_000) },
  );
}

async function artifactDigests(
  project: string,
): Promise<Record<string, string>> {
  const folder = join(project, "artifacts");
  const names = (await readdir(folder)).toSorted();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name): Promise<[string, string]> => [
        name,
        createHash("sha256")
          .update(await readFile(join(folder, name)))
          .digest("hex"),
      ]),
    ),
  );
}

await test("CLV-277 five compiles of the same sources give the same artifacts and bundle digest", () =>
  withFiles(
    {
      ...sources,
      "package.json": '{"name":"fixture","private":true,"type":"module"}',
      "declarations.json": "[]",
      "dependencies.json": "{}",
      "repository/marker": "",
    },
    async (project) => {
      await symlink(
        join(product, "node_modules"),
        join(project, "node_modules"),
      );
      const compiles = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        compile(project);
        compiles.push({
          artifacts: await artifactDigests(project),
          bundleDigest: await retainWorkflowBundle({
            project,
            repository: join(project, "repository"),
            directory: join(project, "workflow-bundles"),
          }),
        });
      }
      const [first] = compiles;
      assert.ok(first);
      assert.deepEqual(Object.keys(first.artifacts), [
        "client.mjs",
        "flow.mjs",
        "flow.mjs.__wf_tmp.js.debug.json",
        "manifest.json",
        "steps.mjs",
        "steps.mjs.debug.json",
      ]);
      assert.deepEqual(compiles, Array(5).fill(first));
    },
  ));
