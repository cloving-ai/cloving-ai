import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { installWorkerHooks } from "../../quality/worker-hook-installation.ts";
import { withFiles } from "./files-fixture.ts";

await test("QG-15 installed hook commands prevent a local worker write before filesystem mutation", async () => {
  await withFiles(
    {
      "workspace/main.ts": "export const value = 1;\n",
      "workspace/package.json": '{"type":"module"}',
    },
    async (directory) => {
      const workspace = join(directory, "workspace");
      const installed = await installWorkerHooks(
        join(directory, "trusted hooks' settings"),
        {
          workspace,
          editableFiles: ["main.ts"],
          sourceFiles: ["main.ts"],
          compilerConfiguration: resolve("tsconfig.json"),
        },
      );
      const settings: unknown = JSON.parse(
        await readFile(installed.settings, "utf8"),
      );
      const hooks = [
        { type: "command", command: installed.command, timeout: 10 },
      ];
      assert.deepEqual(settings, {
        hooks: {
          PreToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks }],
          PostToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks }],
          Stop: [{ hooks }],
        },
      });
      const replacement = "// eslint-disable\nexport const value = 2;";
      const result = spawnSync("/bin/sh", ["-c", installed.command], {
        cwd: workspace,
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Write",
          tool_input: { file_path: "main.ts", content: replacement },
        }),
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(result.error, undefined);
      if (result.status === 0)
        await writeFile(join(workspace, "main.ts"), replacement);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /unapproved-suppression/);
      assert.equal(
        await readFile(join(workspace, "main.ts"), "utf8"),
        "export const value = 1;\n",
      );
    },
  );
});

await test("QG-09 hook installation cannot place its policy inside the worker workspace", async () => {
  await withFiles(
    { "main.ts": "export const value = 1;\n" },
    async (workspace) => {
      await assert.rejects(
        installWorkerHooks(join(workspace, "settings"), {
          workspace,
          editableFiles: ["main.ts"],
          sourceFiles: ["main.ts"],
          compilerConfiguration: resolve("tsconfig.json"),
        }),
        /worker-hook-policy-inside-workspace/,
      );
    },
  );
});
