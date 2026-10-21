import assert from "node:assert/strict";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { preparedProject } from "../tools/self-host-project.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import {
  candidateDeclaration,
  validCandidateSource,
} from "./workflow-candidate-fixtures.ts";

async function project(root: string, compiler: string) {
  const product = join(root, "product");
  await mkdir(join(product, "tools"), { recursive: true });
  await mkdir(join(product, "workflows"));
  await symlink(resolve("node_modules"), join(product, "node_modules"));
  await copyFile(
    join(candidatePackageRoot, "package.json"),
    join(product, "package.json"),
  );
  await symlink(join(candidatePackageRoot, "dist"), join(product, "dist"));
  await writeFile(
    join(product, "workflows/bundled.ts"),
    'export async function bundled() {\n "use workflow";\n return 1;\n}',
  );
  await writeFile(join(product, "tools/compile-workflows.ts"), compiler);
  return {
    product,
    project: join(root, "private-project"),
    repository: join(root, "repo"),
    home: root,
    xdgConfigHome: join(root, "config"),
  };
}

function manifestCompiler(manifest: unknown): string {
  return `import { mkdir, writeFile } from "node:fs/promises";
await mkdir("artifacts", { recursive: true });
for (const name of ["client.mjs", "flow.mjs", "steps.mjs", "flow.mjs.__wf_tmp.js.debug.json", "steps.mjs.debug.json"])
  await writeFile("artifacts/" + name, "synthetic compiled artifact");
await writeFile("artifacts/manifest.json", ${JSON.stringify(JSON.stringify(manifest))});`;
}

await test("CLV-124 missing operator folders preserve bundled startup and remain absent", () =>
  withFiles({ "repo/marker": "" }, async (root) => {
    const settings = await project(
      root,
      manifestCompiler({
        workflows: {
          "workflows/bundled.ts": {
            bundled: { workflowId: "workflow//./workflows/bundled//bundled" },
          },
        },
      }),
    );
    const result = await preparedProject(settings);
    assert.deepEqual(Object.keys(result.manifests), ["bundled"]);
    assert.deepEqual(result.declarations, []);
    assert.deepEqual(result.workflowRefusals, []);
    for (const folder of [join(root, "repo/.cloving"), join(root, "config")])
      await assert.rejects(lstat(folder), { code: "ENOENT" });
  }));

await test("CLV-124 startup stops on a failed compiler without exposing its output", () =>
  withFiles({ "repo/marker": "" }, async (root) => {
    const settings = await project(
      root,
      'process.stderr.write("COMPILER_SENTINEL"); process.exit(1);',
    );
    await assert.rejects(preparedProject(settings), {
      message: "The workflows did not compile.",
    });
  }));

await test("CLV-124 startup rejects malformed compiler output before registration", () =>
  withFiles({ "repo/marker": "" }, async (root) => {
    const settings = await project(root, manifestCompiler([]));
    await assert.rejects(preparedProject(settings), {
      message: "The compiled workflow manifest is invalid.",
    });
  }));

await test("CLV-124 startup rejects a combined bundle missing its admitted candidate", () =>
  withFiles(
    {
      "repo/.cloving/workflows/candidate.ts": validCandidateSource,
      "repo/.cloving/workflows/candidate.declaration.json":
        JSON.stringify(candidateDeclaration),
    },
    async (root) => {
      const settings = await project(
        root,
        manifestCompiler({
          workflows: {
            "workflows/bundled.ts": {
              bundled: { workflowId: "workflow//./workflows/bundled//bundled" },
            },
          },
        }),
      );
      await assert.rejects(preparedProject(settings), {
        message: "The admitted workflow is missing from the compiled bundle.",
      });
      assert.equal(
        await readFile(
          join(root, "repo/.cloving/workflows/candidate.ts"),
          "utf8",
        ),
        validCandidateSource,
      );
    },
  ));

await test("CLV-124 startup rejects an unavailable compiler executable", () =>
  withFiles({ "repo/marker": "" }, async (root) => {
    const settings = await project(root, "");
    const executable = process.execPath;
    try {
      Object.defineProperty(process, "execPath", {
        value: join(root, "missing-node"),
      });
      await assert.rejects(preparedProject(settings), { code: "ENOENT" });
    } finally {
      Object.defineProperty(process, "execPath", { value: executable });
    }
  }));
