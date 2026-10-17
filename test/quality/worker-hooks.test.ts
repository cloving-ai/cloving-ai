import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { withFiles } from "./files-fixture.ts";
import { evaluateWorkerHook } from "../../quality/worker-hooks.ts";
import { parseCheckTimeFactor } from "../../quality/test-execution.ts";
import { runCommand } from "../../quality/command.ts";

function hookTimeoutMilliseconds(factor: string | undefined): number {
  return 10000 * parseCheckTimeFactor(factor);
}

const hookTimeout = hookTimeoutMilliseconds(
  process.env["CLOVING_CHECK_TIME_FACTOR"],
);

await test("CLV-100 scales the QG-15 hook subprocess limit by the check time factor", () => {
  assert.equal(hookTimeoutMilliseconds(undefined), 10000);
  assert.equal(hookTimeoutMilliseconds("3"), 30000);
});

await test("CLV-100 forwards the check time factor to hook test subprocesses", () => {
  const previous = process.env["CLOVING_CHECK_TIME_FACTOR"];
  process.env["CLOVING_CHECK_TIME_FACTOR"] = "3";
  try {
    assert.equal(
      runCommand({
        executable: process.execPath,
        arguments: [
          "-e",
          "process.stdout.write(process.env.CLOVING_CHECK_TIME_FACTOR ?? 'unset')",
        ],
        directory: process.cwd(),
        timeoutMilliseconds: 1000,
      }),
      "3",
    );
  } finally {
    if (previous === undefined) delete process.env["CLOVING_CHECK_TIME_FACTOR"];
    else process.env["CLOVING_CHECK_TIME_FACTOR"] = previous;
  }
});

async function withHook(
  source: string,
  inspect: (
    dispatch: (input: unknown) => { exit: number | null; diagnostic: string },
    directory: string,
  ) => Promise<void> | void,
): Promise<void> {
  await withFiles(
    {
      "workspace/main.ts": source,
      "workspace/package.json": '{"type":"module"}',
      "policy.json": "{}",
    },
    async (directory) => {
      const workspace = join(directory, "workspace");
      const policy = join(directory, "policy.json");
      await writeFile(
        policy,
        JSON.stringify({
          workspace,
          editableFiles: ["main.ts"],
          sourceFiles: ["main.ts"],
          compilerConfiguration: resolve("tsconfig.json"),
        }),
      );
      const dispatch = (input: unknown) => {
        const result = spawnSync(
          process.execPath,
          [resolve("tools/worker-hook.ts"), policy],
          {
            input: JSON.stringify(input),
            encoding: "utf8",
            timeout: hookTimeout,
            env: { PATH: process.env["PATH"], NODE_DISABLE_COMPILE_CACHE: "1" },
          },
        );
        assert.equal(result.error, undefined);
        return { exit: result.status, diagnostic: result.stderr };
      };
      await inspect(dispatch, workspace);
    },
  );
}

await test("QG-15 executed PreToolUse hook denies protected writes and suppression additions", async () => {
  await withHook("export const value = 1;\n", (dispatch) => {
    const configuration = dispatch({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: {
        file_path: "eslint.config.mjs",
        content: "export default [];",
      },
    });
    assert.equal(configuration.exit, 2);
    assert.match(configuration.diagnostic, /outside-worker-edit-scope/);
    const suppression = dispatch({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: {
        file_path: "main.ts",
        content: "// eslint-disable\nexport const value = 1;",
      },
    });
    assert.equal(suppression.exit, 2);
    assert.match(suppression.diagnostic, /unapproved-suppression/);
  });
});

await test("QG-15 executed PostToolUse and Stop hooks report size and request repair once", async () => {
  await withHook(
    `export function oversized(): number {\n${"\n".repeat(61)}return 1;\n}\n`,
    (dispatch) => {
      const post = dispatch({
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: "main.ts" },
      });
      assert.equal(post.exit, 2);
      assert.match(post.diagnostic, /max-lines-per-function/);
      const stop = dispatch({
        hook_event_name: "Stop",
        stop_hook_active: false,
      });
      assert.equal(stop.exit, 2);
      assert.match(stop.diagnostic, /max-lines-per-function/);
      assert.equal(
        dispatch({ hook_event_name: "Stop", stop_hook_active: true }).exit,
        0,
      );
    },
  );
});

await test("QG-10 executed hook rejects malformed events without accepting a write", async () => {
  await withHook("export const value = 1;\n", (dispatch) => {
    assert.equal(dispatch({ hook_event_name: "PreToolUse" }).exit, 2);
    assert.equal(
      dispatch({ hook_event_name: "Stop", stop_hook_active: "false" }).exit,
      2,
    );
  });
});

await test("QG-15 JSX variants cannot skip suppression checks", async () => {
  await withFiles(
    {
      "main.tsx": "export {};",
      "main.jsx": "export {};",
      "package.json": '{"type":"module"}',
    },
    async (workspace) => {
      for (const file of ["main.tsx", "main.jsx"]) {
        const result = await evaluateWorkerHook(
          {
            hook_event_name: "PreToolUse",
            tool_name: "Write",
            tool_input: {
              file_path: file,
              content: "// eslint-disable\nexport {};",
            },
          },
          {
            workspace,
            editableFiles: [file],
            sourceFiles: [file],
            compilerConfiguration: resolve("tsconfig.json"),
          },
        );
        assert.equal(result.exit, 2);
        assert.match(result.diagnostic, /unapproved-suppression/);
        await writeFile(
          join(workspace, file),
          `export function oversized() {\n${"\n".repeat(61)}return 1;\n}`,
        );
        const post = await evaluateWorkerHook(
          {
            hook_event_name: "PostToolUse",
            tool_name: "Write",
            tool_input: { file_path: file },
          },
          {
            workspace,
            editableFiles: [file],
            sourceFiles: [file],
            compilerConfiguration: resolve("tsconfig.json"),
          },
        );
        assert.equal(post.exit, 2);
        assert.match(post.diagnostic, /max-lines-per-function/);
      }
    },
  );
});

await test("QG-10 hook rejects oversized input before source analysis", async () => {
  await withHook("export const value = 1;\n", async (_dispatch, directory) => {
    const inputFile = join(directory, "input.json");
    await writeFile(
      inputFile,
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "main.ts", content: " ".repeat(1024 * 1024) },
      }),
    );
    const input = await open(inputFile, "r");
    try {
      const result = spawnSync(
        process.execPath,
        [resolve("tools/worker-hook.ts"), resolve(directory, "../policy.json")],
        {
          stdio: [input.fd, "pipe", "pipe"],
          encoding: "utf8",
          timeout: hookTimeout,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /worker-hook-input-limit/);
    } finally {
      await input.close();
    }
  });
});

await test("QG-15 hook accepts a complete streamed edit below the input limit", async () => {
  await withHook("export const value = 1;\n", (dispatch) => {
    const result = dispatch({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: {
        file_path: "main.ts",
        content: " ".repeat(700000) + "export {};",
      },
    });
    assert.equal(result.exit, 0, result.diagnostic);
  });
});

await test("QG-10 hook bounds an input stream that never closes", async () => {
  await withHook("export const value = 1;\n", async (_dispatch, directory) => {
    const child = spawn(
      process.execPath,
      [resolve("tools/worker-hook.ts"), resolve(directory, "../policy.json")],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let diagnostic = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      diagnostic += chunk;
    });
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5000);
    try {
      child.stdin.write("{");
      const exit = await new Promise<number | null>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("close", resolveExit);
      });
      assert.equal(exit, 2);
      assert.match(diagnostic, /worker-hook-input-timeout/);
    } finally {
      clearTimeout(deadline);
      child.kill("SIGKILL");
    }
  });
});
