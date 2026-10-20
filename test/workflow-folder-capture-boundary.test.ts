import assert from "node:assert/strict";
import filesystem, { readFile, unlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import {
  captureWorkflowCandidate,
  inspectWorkflowFolder,
  workflowCaptureFailure,
} from "../tools/workflow-folder-capture.ts";
import { folderInput, operatorFiles } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

function anchoredLinuxOpen(anchored: string[]): typeof filesystem.open {
  const open = filesystem.open;
  const paths = new Map<number, string>();
  return async (path, flags) => {
    const match = /^\/proc\/self\/fd\/(\d+)\/(.+)$/.exec(String(path));
    let resolved = String(path);
    if (!match) {
      const handle = await open(resolved, flags);
      paths.set(handle.fd, resolved);
      return handle;
    }
    const parent = paths.get(Number(match[1]));
    if (!parent || !match[2])
      throw new Error("Missing fixture descriptor anchor.");
    resolved = join(parent, match[2]);
    anchored.push(resolved);
    const handle = await open(resolved, flags);
    paths.set(handle.fd, resolved);
    return handle;
  };
}

await test("CLV-124 captures both file identities before reading either file", () =>
  withFiles(operatorFiles("project", "project"), async (directory) => {
    const original = filesystem.open;
    let changed = false;
    filesystem.open = async (path, flags) => {
      if (String(path).endsWith("project.ts")) {
        changed = true;
        await writeFile(
          join(directory, "repo/.cloving/workflows/project.declaration.json"),
          "{}",
        );
      }
      return original(path, flags);
    };
    syncBuiltinESMExports();
    try {
      const result = await loadWorkflowFolders(folderInput(directory));
      assert.equal(changed, true);
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

await test("CLV-124 descriptor-anchored capture reads Linux components without following operator links", () =>
  withFiles(operatorFiles("project", "project"), async (directory) => {
    const folder = await inspectWorkflowFolder(join(directory, "repo"), [
      ".cloving",
      "workflows",
    ]);
    const original = filesystem.open;
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    assert.ok(platform);
    const anchored: string[] = [];
    filesystem.open = anchoredLinuxOpen(anchored);
    Object.defineProperty(process, "platform", { value: "linux" });
    syncBuiltinESMExports();
    try {
      const snapshot = await captureWorkflowCandidate(folder, "project.ts");
      assert.equal(
        snapshot.source,
        await readFile(join(folder.path, "project.ts"), "utf8"),
      );
      assert.equal(anchored.length, 6);
      assert.equal(
        anchored.every((path) =>
          path.startsWith(join(directory, "repo") + "/"),
        ),
        true,
      );
    } finally {
      Object.defineProperty(process, "platform", platform);
      filesystem.open = original;
      syncBuiltinESMExports();
    }
  }));

await test("CLV-124 capture failures expose fixed codes without error details", () => {
  assert.equal(
    workflowCaptureFailure(new Error("private-path-sentinel")),
    "workflow-read-failed",
  );
  assert.equal(workflowCaptureFailure(null), "workflow-read-failed");
  assert.equal(
    workflowCaptureFailure(
      Object.assign(new Error("private"), { code: "ELOOP" }),
    ),
    "unsafe-workflow-path",
  );
});

await test("CLV-124 disappearance after a captured read is a source change", () =>
  withFiles(operatorFiles("project", "project"), async (directory) => {
    const original = filesystem.open;
    filesystem.open = async (path, flags) => {
      if (String(path).endsWith("project.declaration.json"))
        await unlink(join(directory, "repo/.cloving/workflows/project.ts"));
      return original(path, flags);
    };
    syncBuiltinESMExports();
    try {
      const result = await loadWorkflowFolders(folderInput(directory));
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
