import assert from "node:assert/strict";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import nodeModule, { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { workflowBuildKey } from "../tools/self-host-build-cache.ts";
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

for (const name of ["workflow", "@workflow/core"]) {
  await test(`CLV-219 source bootstrap refuses an unavailable ${name} manifest before compilation`, () =>
    withFiles({ "repo/marker": "" }, async (root) => {
      const settings = await project(root, manifestCompiler({}));
      const original = nodeModule.findPackageJSON;
      nodeModule.findPackageJSON = (specifier, parent) =>
        specifier === name ? undefined : original(specifier, parent);
      syncBuiltinESMExports();
      try {
        await assert.rejects(preparedProject(settings), {
          message: `missing-runtime-dependency: ${name}`,
        });
        await assert.rejects(lstat(join(settings.project, "artifacts")), {
          code: "ENOENT",
        });
      } finally {
        nodeModule.findPackageJSON = original;
        syncBuiltinESMExports();
      }
    }));
}

await test("CLV-262 missing operator folders produce an empty bundle and remain absent", () =>
  withFiles({ "repo/marker": "" }, async (root) => {
    const settings = await project(root, manifestCompiler({}));
    const result = await preparedProject(settings);
    assert.deepEqual(Object.keys(result.manifests), []);
    assert.deepEqual(result.declarations, []);
    assert.deepEqual(result.workflowRefusals, []);
    for (const folder of [join(root, "repo/.cloving"), join(root, "config")])
      await assert.rejects(lstat(folder), { code: "ENOENT" });
  }));

await test("CLV-154 startup shares retained modules inside its bundle store and preserves installed dependencies", () =>
  withFiles(
    { "repo/marker": "", "node_modules/installed/package.json": "{}" },
    async (root) => {
      const settings = await project(root, manifestCompiler({}));
      for (const attempt of ["first", "second"]) {
        const result = await preparedProject(settings);
        assert.deepEqual(Object.keys(result.manifests), []);
        assert.ok((await lstat(join(root, "node_modules"))).isDirectory());
        assert.equal(
          await readFile(
            join(root, "node_modules/installed/package.json"),
            "utf8",
          ),
          "{}",
        );
        assert.equal(
          await readlink(join(root, "workflow-bundles/node_modules")),
          join(settings.project, "node_modules"),
          `${attempt} startup`,
        );
      }
    },
  ));

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
      const settings = await project(root, manifestCompiler({}));
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

await test("CLV-347 restart reuses intact compiled workflows until a compiler input changes", () =>
  withFiles({ "repo/marker": "" }, async (root) => {
    const count = join(root, "compilations");
    const compiler = `${manifestCompiler({})}
import { appendFile } from "node:fs/promises";
await appendFile(${JSON.stringify(count)}, "compiled\\n");`;
    const settings = await project(root, compiler);
    const first = await preparedProject(settings);
    const again = await preparedProject(settings);
    assert.equal(again.bundleDigest, first.bundleDigest);
    assert.equal(await readFile(count, "utf8"), "compiled\n");
    for (const [file, source] of [
      ["tools/compile-workflows.ts", `${compiler}\nexport {};`],
      ["src/helper.ts", "export const helper = 1;"],
      [
        "package.json",
        (await readFile(join(settings.product, "package.json"), "utf8")) + "\n",
      ],
    ]) {
      assert.ok(file !== undefined && source !== undefined);
      await mkdir(join(settings.product, file, ".."), { recursive: true });
      await writeFile(join(settings.product, file), source);
      await preparedProject(settings);
    }
    assert.equal((await readFile(count, "utf8")).split("\n").length - 1, 4);
    const latest = await preparedProject(settings);
    const retained = join(
      root,
      "workflow-bundles",
      latest.bundleDigest,
      "artifacts/client.mjs",
    );
    await writeFile(retained, "damaged artifact");
    await assert.rejects(preparedProject(settings), {
      message: "pinned-workflow-unavailable",
    });
    assert.equal((await readFile(count, "utf8")).split("\n").length - 1, 5);
  }));

await test("CLV-347 compiled workflow keys include staged sources, helper bytes, and dependency closure", () =>
  withFiles(
    { "product/src/helper.ts": "first", "project/workflows/turn.ts": "first" },
    async (root) => {
      const input = {
        product: join(root, "product"),
        project: join(root, "project"),
        dependencies: "first",
      };
      const first = await workflowBuildKey(input);
      await writeFile(join(input.project, "workflows/turn.ts"), "second");
      const source = await workflowBuildKey(input);
      assert.notEqual(source, first);
      await writeFile(join(input.product, "src/helper.ts"), "second");
      const helper = await workflowBuildKey(input);
      assert.notEqual(helper, source);
      assert.notEqual(
        await workflowBuildKey({ ...input, dependencies: "second" }),
        helper,
      );
      assert.notEqual(
        await workflowBuildKey({ ...input, recordedProject: "different" }),
        helper,
      );
      const staged = join(root, "staged");
      await mkdir(join(staged, "workflows"), { recursive: true });
      await writeFile(join(staged, "workflows/turn.ts"), "second");
      assert.equal(
        await workflowBuildKey({
          ...input,
          project: staged,
          recordedProject: input.project,
        }),
        helper,
      );
      await writeFile(join(input.product, "tools"), "invalid directory");
      await assert.rejects(workflowBuildKey(input), { code: "ENOTDIR" });
    },
  ));
