import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { withFiles } from "./files-fixture.ts";
import { evaluateWorkerHook } from "../../quality/worker-hooks.ts";
import { runCommand } from "../../quality/command.ts";
import {
  hookTimeoutMilliseconds,
  hookEnvironment,
  hookFailureMessage,
  hookDiagnostic,
  probeHookCheck,
  runHook,
  withHook,
} from "./worker-hook-fixture.ts";

await test("CLV-100 scales the QG-15 hook subprocess limit by the check time factor", () => {
  assert.equal(hookTimeoutMilliseconds(undefined), 30000);
  assert.equal(hookTimeoutMilliseconds("3"), 90000);
});

await test("CLV-107 scales the inner hook check limit by the hook environment factor", () => {
  for (const [factor, timeout] of [
    [undefined, 15000],
    ["3", 45000],
  ] as const) {
    const result = probeHookCheck({
      environment: { CLOVING_CHECK_TIME_FACTOR: factor },
    });
    assert.deepEqual(JSON.parse(result.stdout), {
      check: resolve("tools/worker-hook-check.ts"),
      timeout,
    });
    assert.equal(result.diagnostic, "");
  }
});

await test("CLV-107 QG-15 passes the check time factor to each hook subprocess", () => {
  const previous = process.env["CLOVING_CHECK_TIME_FACTOR"];
  process.env["CLOVING_CHECK_TIME_FACTOR"] = "3";
  try {
    const result = runHook({
      arguments: [
        "-e",
        "process.stdout.write(process.env.CLOVING_CHECK_TIME_FACTOR ?? 'unset')",
      ],
      expectedExit: 0,
    });
    assert.equal(result.stdout, "3");
    assert.equal(hookEnvironment()["CLOVING_CHECK_TIME_FACTOR"], "3");
  } finally {
    if (previous === undefined) delete process.env["CLOVING_CHECK_TIME_FACTOR"];
    else process.env["CLOVING_CHECK_TIME_FACTOR"] = previous;
  }
});

await test("CLV-107 rejects invalid factors before any inner hook check runs", () => {
  for (const factor of ["0", "10", "1.5", "", "3x"]) {
    const result = probeHookCheck({
      environment: { CLOVING_CHECK_TIME_FACTOR: factor },
      expectedExit: 2,
    });
    assert.equal(
      result.diagnostic,
      "CLOVING_CHECK_TIME_FACTOR must be a whole number from 1 to 9",
    );
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /check:start|input-policy:read/);
  }
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

await test("CLV-104 hook trace reports ordered phases with nondecreasing elapsed milliseconds", async () => {
  await withHook("export const value = 1;\n", (dispatch) => {
    const result = dispatch(
      { hook_event_name: "Stop", stop_hook_active: false },
      { expectedExit: 0 },
    );
    assert.equal(result.exit, 0, result.diagnostic);
    const trace = [
      ...result.stderr.matchAll(/^\[cloving-worker-hook\] (\d+)ms (\S+)$/gm),
    ];
    assert.deepEqual(
      trace.map((line) => line[2]),
      [
        "start",
        "input:read",
        "check:start",
        "input-policy:read",
        "compiler:start",
        "compiler:end",
        "lint:start",
        "lint:end",
        "structure:start",
        "structure:end",
        "check:end",
      ],
    );
    const times = trace.map((line) => Number(line[1]));
    assert.deepEqual(
      times,
      [...times].sort((left, right) => left - right),
    );
    assert.ok(times.every((time) => Number.isInteger(time) && time >= 0));
    assert.equal(result.stdout, "");
  });
});

await test("CLV-104 hook without the trace setting preserves its exact output", async () => {
  await withHook("export const value = 1;\n", (dispatch) => {
    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: {
        file_path: "eslint.config.mjs",
        content: "export default [];",
      },
    };
    const traced = dispatch(event);
    for (const setting of [undefined, "0", "true"]) {
      const plain = dispatch(event, {
        environment: { CLOVING_WORKER_HOOK_TRACE: setting },
      });
      assert.doesNotMatch(plain.stderr, /\[cloving-worker-hook\]/);
      assert.equal(plain.stderr, "outside-worker-edit-scope");
      assert.equal(plain.stdout, "");
      assert.equal(plain.exit, 2);
      assert.deepEqual(
        {
          exit: traced.exit,
          stdout: traced.stdout,
          diagnostic: traced.diagnostic,
        },
        {
          exit: plain.exit,
          stdout: plain.stdout,
          diagnostic: plain.diagnostic,
        },
      );
    }
  });
});

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
        dispatch(
          { hook_event_name: "Stop", stop_hook_active: true },
          { expectedExit: 0 },
        ).exit,
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
      const result = runHook({
        arguments: [
          resolve("tools/worker-hook.ts"),
          resolve(directory, "../policy.json"),
        ],
        inputFile: input.fd,
      });
      assert.equal(result.exit, 2);
      assert.match(result.diagnostic, /worker-hook-input-limit/);
    } finally {
      await input.close();
    }
  });
});

await test("QG-15 hook accepts a complete streamed edit below the input limit", async () => {
  await withHook("export const value = 1;\n", (dispatch) => {
    const result = dispatch(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: {
          file_path: "main.ts",
          content: " ".repeat(700000) + "export {};",
        },
      },
      { expectedExit: 0 },
    );
    assert.equal(result.exit, 0, result.diagnostic);
  });
});

await test("QG-10 hook bounds an input stream that never closes", async () => {
  await withHook("export const value = 1;\n", async (_dispatch, directory) => {
    const started = performance.now();
    const child = spawn(
      process.execPath,
      [resolve("tools/worker-hook.ts"), resolve(directory, "../policy.json")],
      { stdio: ["pipe", "pipe", "pipe"], env: hookEnvironment() },
    );
    let diagnostic = "";
    let error: NodeJS.ErrnoException | undefined;
    child.once("error", (failure) => {
      error = failure;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      diagnostic += chunk;
    });
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5000);
    try {
      child.stdin.write("{");
      const exit = await new Promise<number | null>((resolveExit) => {
        child.once("close", resolveExit);
      });
      assert.equal(
        exit,
        2,
        hookFailureMessage(
          {
            status: exit,
            signal: child.signalCode,
            stderr: diagnostic,
            ...(error ? { error } : {}),
          },
          started,
        ),
      );
      diagnostic = hookDiagnostic(diagnostic);
      assert.match(diagnostic, /worker-hook-input-timeout/);
    } finally {
      clearTimeout(deadline);
      child.kill("SIGKILL");
    }
  });
});
