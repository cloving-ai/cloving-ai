import assert from "node:assert/strict";
import filesystem, {
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import {
  captureWorkflowCandidate,
  inspectWorkflowFolder,
} from "../tools/workflow-folder-capture.ts";
import { folderInput, operatorFiles } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

for (const name of [
  "../outside.ts",
  "/outside.ts",
  "~/outside.ts",
  "~outside.ts",
  "C:\\outside.ts",
]) {
  await test(`CLV-124 refuses unsafe captured candidate name ${name}`, () =>
    withFiles(
      {
        ...operatorFiles("project", "project"),
        "repo/.cloving/outside.ts": "outside-sentinel",
        "repo/.cloving/workflows/~outside.ts": "source",
      },
      async (directory) => {
        const folder = await inspectWorkflowFolder(join(directory, "repo"), [
          ".cloving",
          "workflows",
        ]);
        await assert.rejects(
          captureWorkflowCandidate(folder, name),
          /^Error: unsafe-workflow-path$/,
        );
      },
    ));
}

for (const target of ["project.ts", "project.declaration.json", "workflows"]) {
  for (const replacement of ["file", "link"] as const) {
    await test(`CLV-124 refuses ${target} replacement by ${replacement} during capture`, () =>
      withFiles(operatorFiles("project", "project"), async (directory) => {
        const original = filesystem.open;
        const folder = join(directory, "repo/.cloving/workflows");
        const path = target === "workflows" ? folder : join(folder, target);
        let replaced = false;
        filesystem.open = async (openingPath, flags) => {
          if (
            !replaced &&
            String(openingPath).endsWith(
              target === "workflows" ? "project.ts" : target,
            )
          ) {
            replaced = true;
            const bytes =
              target === "workflows" ? undefined : await readFile(path);
            await rename(path, path + ".saved");
            if (replacement === "link") await symlink(path + ".saved", path);
            else if (bytes) await writeFile(path, bytes);
            else
              await filesystem.cp(path + ".saved", path, { recursive: true });
          }
          return original(openingPath, flags);
        };
        syncBuiltinESMExports();
        try {
          const result = await loadWorkflowFolders(folderInput(directory));
          assert.equal(replaced, true);
          assert.deepEqual(result.candidates, []);
          assert.deepEqual(result.refusals, [
            {
              scope: "project",
              label: "project.ts",
              codes: ["workflow-source-changed"],
            },
          ]);
        } finally {
          filesystem.open = original;
          syncBuiltinESMExports();
        }
      }));
  }
}

await test("CLV-124 admission uses one captured source and declaration even after files change", () =>
  withFiles(operatorFiles("project", "project"), async (directory) => {
    const original = filesystem.mkdtemp;
    const sourcePath = join(directory, "repo/.cloving/workflows/project.ts");
    const declarationPath = sourcePath.replace(/\.ts$/, ".declaration.json");
    const source = await readFile(sourcePath, "utf8");
    const declaration = await readFile(declarationPath, "utf8");
    let changed = false;
    const descriptor = Object.getOwnPropertyDescriptor(filesystem, "mkdtemp");
    assert.ok(descriptor);
    Object.defineProperty(filesystem, "mkdtemp", {
      configurable: true,
      value: async (...args: Parameters<typeof original>) => {
        if (args[0].includes("cloving-candidate-")) {
          changed = true;
          await writeFile(sourcePath, "edited-source-sentinel");
          await writeFile(declarationPath, "edited-declaration-sentinel");
        }
        return original(...args);
      },
    });
    syncBuiltinESMExports();
    try {
      const result = await loadWorkflowFolders(folderInput(directory));
      assert.equal(changed, true);
      assert.deepEqual(result.refusals, []);
      const candidate = result.candidates[0];
      assert.ok(candidate);
      assert.equal(candidate.source, source);
      assert.equal(candidate.declaration, declaration);
    } finally {
      Object.defineProperty(filesystem, "mkdtemp", descriptor);
      syncBuiltinESMExports();
    }
  }));
