import assert from "node:assert/strict";
import filesystem, { readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import {
  captureWorkflowCandidate,
  inspectWorkflowFolder,
  workflowFolderEntries,
} from "../tools/workflow-folder-capture.ts";
import { folderInput, operatorFiles } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

await test("CLV-124 invalid declaration encoding is refused while preserving a captured source", () =>
  withFiles(operatorFiles("project", "project"), async (directory) => {
    await writeFile(
      join(directory, "repo/.cloving/workflows/project.declaration.json"),
      Buffer.from([255]),
    );
    const result = await loadWorkflowFolders(folderInput(directory));
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.refusals, [
      { scope: "project", label: "project.ts", codes: ["invalid-declaration"] },
    ]);
  }));

for (const failure of ["edited", "short", "unreadable"] as const) {
  await test(`CLV-124 refuses ${failure} file capture without details`, () =>
    withFiles(operatorFiles("project", "project"), async (directory) => {
      const original = filesystem.open;
      filesystem.open = async (path, flags) => {
        const source = String(path).endsWith("project.ts");
        if (source && failure === "unreadable")
          throw Object.assign(new Error("private-sentinel"), {
            code: "EACCES",
          });
        const handle = await original(path, flags);
        const read = handle.readFile.bind(handle);
        Object.defineProperty(handle, "readFile", {
          value: async () => {
            const bytes = await read();
            if (source && failure === "edited")
              await writeFile(
                join(directory, "repo/.cloving/workflows/project.ts"),
                "edited",
              );
            return source && failure === "short" ? Buffer.from("short") : bytes;
          },
        });
        return handle;
      };
      syncBuiltinESMExports();
      try {
        const result = await loadWorkflowFolders(folderInput(directory));
        assert.deepEqual(result.candidates, []);
        assert.deepEqual(result.refusals, [
          {
            scope: "project",
            label: "project.ts",
            codes: [
              failure === "unreadable"
                ? "workflow-read-failed"
                : "workflow-source-changed",
            ],
          },
        ]);
        assert.equal(
          JSON.stringify(result.refusals).includes("private-sentinel"),
          false,
        );
      } finally {
        filesystem.open = original;
        syncBuiltinESMExports();
      }
    }));
}

await test("CLV-124 unsupported file platforms fail closed", () =>
  withFiles(operatorFiles("project", "project"), async (directory) => {
    const folder = await inspectWorkflowFolder(join(directory, "repo"), [
      ".cloving",
      "workflows",
    ]);
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    assert.ok(platform);
    Object.defineProperty(process, "platform", { value: "unsupported" });
    try {
      const result = await captureWorkflowCandidate(folder, "project.ts");
      assert.equal(result.source, undefined);
      assert.equal(result.declaration, undefined);
      assert.deepEqual(result.codes, ["workflow-read-failed"]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  }));

function anchoredLinuxFiles() {
  const paths = new Map<number, string>();
  const open = filesystem.open;
  const readdir = filesystem.readdir;
  const descriptor = Object.getOwnPropertyDescriptor(filesystem, "readdir");
  assert.ok(descriptor);
  filesystem.open = async (path, flags) => {
    let resolved = String(path);
    const match = /^\/proc\/self\/fd\/(\d+)\/(.+)$/.exec(resolved);
    if (!match) {
      const handle = await open(resolved, flags);
      paths.set(handle.fd, resolved);
      return handle;
    }
    const parent = paths.get(Number(match[1]));
    if (!parent || !match[2]) throw new Error("Missing fixture anchor.");
    resolved = join(parent, match[2]);
    const handle = await open(resolved, flags);
    paths.set(handle.fd, resolved);
    return handle;
  };
  Object.defineProperty(filesystem, "readdir", {
    configurable: true,
    value: async (...args: Parameters<typeof readdir>) => {
      const match = /^\/proc\/self\/fd\/(\d+)$/.exec(String(args[0]));
      if (!match) return readdir(...args);
      const path = paths.get(Number(match[1]));
      if (!path) throw new Error("Missing listing fixture anchor.");
      args[0] = path;
      return readdir(...args);
    },
  });
  syncBuiltinESMExports();
  return () => {
    filesystem.open = open;
    Object.defineProperty(filesystem, "readdir", descriptor);
    syncBuiltinESMExports();
  };
}

await test("CLV-124 Linux listing uses a retained directory descriptor", () =>
  withFiles(operatorFiles("project", "project"), async (directory) => {
    const folder = await inspectWorkflowFolder(join(directory, "repo"), [
      ".cloving",
      "workflows",
    ]);
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    assert.ok(platform);
    const restore = anchoredLinuxFiles();
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      assert.deepEqual((await workflowFolderEntries(folder)).sort(), [
        "project.declaration.json",
        "project.ts",
      ]);
      assert.equal(
        await readFile(join(folder.path, "project.ts"), "utf8"),
        Object.values(operatorFiles("project", "project"))[0],
      );
    } finally {
      Object.defineProperty(process, "platform", platform);
      restore();
    }
  }));
