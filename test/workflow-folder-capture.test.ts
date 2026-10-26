import assert from "node:assert/strict";
import filesystem, {
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { test } from "node:test";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import {
  captureWorkflowCandidate,
  inspectWorkflowFolder,
} from "../tools/workflow-folder-capture.ts";
import { folderInput, operatorFiles } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { validCandidateSource } from "./workflow-candidate-fixtures.ts";

const helperFiles = {
  ...operatorFiles("project", "project"),
  "repo/.cloving/workflows/project.ts": `${validCandidateSource.replaceAll("candidate", "project")}\nimport { prompt } from "./helpers/prompts.ts";`,
  "repo/.cloving/workflows/helpers/prompts.ts":
    'export function prompt() { return "captured-helper"; }',
};

function changeAncestorDuringCapture(path: string) {
  const original = filesystem.open;
  let changed = false;
  filesystem.open = async (openingPath, flags) => {
    if (changed || !String(openingPath).endsWith("/first.ts"))
      return original(openingPath, flags);
    changed = true;
    await writeFile(join(path, "unrelated"), "new");
    return original(openingPath, flags);
  };
  syncBuiltinESMExports();
  return {
    get changed() {
      return changed;
    },
    restore: () => {
      filesystem.open = original;
      syncBuiltinESMExports();
    },
  };
}

for (const location of [
  { scope: "project", ancestor: "repo" },
  { scope: "project", ancestor: "repo/.cloving" },
  { scope: "user", ancestor: "config" },
  { scope: "user", ancestor: "config/cloving" },
] as const) {
  await test(`CLV-124 unrelated changes in ${location.ancestor} preserve current and later candidates`, () =>
    withFiles(
      {
        ...operatorFiles(location.scope, "first"),
        ...operatorFiles(location.scope, "second"),
        "repo/tracked.txt": "repository",
      },
      async (directory) => {
        const capture = changeAncestorDuringCapture(
          join(directory, location.ancestor),
        );
        try {
          const result = await loadWorkflowFolders(folderInput(directory));
          assert.equal(capture.changed, true);
          assert.deepEqual(result.refusals, []);
          assert.deepEqual(
            result.candidates.map(({ scope, label }) => ({ scope, label })),
            [
              { scope: location.scope, label: "first.ts" },
              { scope: location.scope, label: "second.ts" },
            ],
          );
        } finally {
          capture.restore();
        }
      },
    ));
}

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

function replaceEntryDuringCapture(location: {
  path: string;
  target: string;
  replacement: "file" | "link";
}) {
  const original = filesystem.open;
  let replaced = false;
  filesystem.open = async (openingPath, flags) => {
    if (
      replaced ||
      !String(openingPath).endsWith(
        location.target === "workflows"
          ? "project.ts"
          : basename(location.target),
      )
    )
      return original(openingPath, flags);

    replaced = true;
    const bytes =
      location.target === "workflows"
        ? undefined
        : await readFile(location.path);
    await rename(location.path, location.path + ".saved");
    if (location.replacement === "link")
      await symlink(location.path + ".saved", location.path);
    else if (bytes) await writeFile(location.path, bytes);
    else
      await filesystem.cp(location.path + ".saved", location.path, {
        recursive: true,
      });
    return original(openingPath, flags);
  };
  syncBuiltinESMExports();
  return {
    get replaced() {
      return replaced;
    },
    restore: () => {
      filesystem.open = original;
      syncBuiltinESMExports();
    },
  };
}

for (const target of [
  "project.ts",
  "project.declaration.json",
  "workflows",
  "helpers/prompts.ts",
]) {
  for (const replacement of ["file", "link"] as const) {
    await test(`CLV-124 refuses ${target} replacement by ${replacement} during capture`, () =>
      withFiles(helperFiles, async (directory) => {
        const folder = join(directory, "repo/.cloving/workflows");
        const capture = replaceEntryDuringCapture({
          path: target === "workflows" ? folder : join(folder, target),
          target,
          replacement,
        });
        try {
          const result = await loadWorkflowFolders(folderInput(directory));
          assert.equal(capture.replaced, true);
          assert.deepEqual(result.candidates, []);
          assert.deepEqual(result.refusals, [
            {
              scope: "project",
              label: "project.ts",
              codes: ["workflow-source-changed"],
            },
          ]);
        } finally {
          capture.restore();
        }
      }));
  }
}

await test("CLV-124 admission uses one captured source and declaration even after files change", () =>
  withFiles(helperFiles, async (directory) => {
    const original = filesystem.mkdtemp;
    const sourcePath = join(directory, "repo/.cloving/workflows/project.ts");
    const declarationPath = sourcePath.replace(/\.ts$/, ".declaration.json");
    const source = await readFile(sourcePath, "utf8");
    const declaration = await readFile(declarationPath, "utf8");
    const helperPath = join(
      directory,
      "repo/.cloving/workflows/helpers/prompts.ts",
    );
    const helper = await readFile(helperPath, "utf8");
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
          await writeFile(helperPath, "edited-helper-sentinel");
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
      assert.deepEqual(candidate.helpers, { "helpers/prompts.ts": helper });
    } finally {
      Object.defineProperty(filesystem, "mkdtemp", descriptor);
      syncBuiltinESMExports();
    }
  }));
