import ts from "typescript";
import { extname, resolve } from "node:path";
import { compilerProgram } from "./compiler.ts";
import { checkLint } from "./source-checks.ts";
import { inspectStructure } from "./structure.ts";
import { checkSuppressions } from "./suppression-approval.ts";
import { readWorkerHookEvent } from "./worker-hook-input.ts";
import type { WorkerHookPolicy } from "./worker-hook-input.ts";
import { proposedWorkerText, workerEditFile } from "./worker-edit.ts";
import { traceWorkerHook } from "./worker-hook-trace.ts";

export async function evaluateWorkerHook(
  input: unknown,
  policy: WorkerHookPolicy,
): Promise<{ exit: number; diagnostic: string }> {
  try {
    const event = readWorkerHookEvent(input);
    if (event.event === "Stop" && event.active)
      return { exit: 0, diagnostic: "" };
    if (event.event !== "Stop") {
      const file = await workerEditFile(event.file, policy);
      if (
        ![
          ".ts",
          ".mts",
          ".cts",
          ".tsx",
          ".js",
          ".mjs",
          ".cjs",
          ".jsx",
        ].includes(extname(file))
      )
        return { exit: 0, diagnostic: "" };
      if (event.event === "PreToolUse") {
        checkSuppressions(
          [
            ts.createSourceFile(
              file,
              await proposedWorkerText(event, file),
              ts.ScriptTarget.Latest,
              true,
            ),
          ],
          [],
        );
        return { exit: 0, diagnostic: "" };
      }
    }
    await checkWorkerSources(policy);
    return { exit: 0, diagnostic: "" };
  } catch (error) {
    return {
      exit: 2,
      diagnostic: error instanceof Error ? error.message : "worker-hook-failed",
    };
  }
}

async function checkWorkerSources(policy: WorkerHookPolicy): Promise<void> {
  const files = policy.sourceFiles.map((file) =>
    resolve(policy.workspace, file),
  );
  traceWorkerHook("compiler:start");
  const program = compilerProgram(policy.workspace, {
    files,
    trustedConfiguration: policy.compilerConfiguration,
  });
  traceWorkerHook("compiler:end");
  traceWorkerHook("lint:start");
  await checkLint(policy.workspace, { files, approvals: [], program });
  traceWorkerHook("lint:end");
  traceWorkerHook("structure:start");
  const findings = inspectStructure(program);
  traceWorkerHook("structure:end");
  if (findings.length > 0) throw new Error(JSON.stringify(findings));
}
