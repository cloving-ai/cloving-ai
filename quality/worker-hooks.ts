import ts from "typescript";
import { extname, resolve } from "node:path";
import { compilerProgram } from "./compiler.ts";
import { checkLint } from "./source-checks.ts";
import { inspectStructure } from "./structure.ts";
import { checkSuppressions } from "./suppression-approval.ts";
import { readWorkerHookEvent } from "./worker-hook-input.ts";
import type { WorkerHookEvent, WorkerHookPolicy } from "./worker-hook-input.ts";
import { proposedWorkerText, workerEditFile } from "./worker-edit.ts";
import { traceWorkerHook } from "./worker-hook-trace.ts";

const sourceExtensions = [
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
];

export async function evaluateWorkerHook(
  input: unknown,
  policy: WorkerHookPolicy,
): Promise<{ exit: number; diagnostic: string }> {
  try {
    await checkWorkerEvent(readWorkerHookEvent(input), policy);
    return { exit: 0, diagnostic: "" };
  } catch (error) {
    return {
      exit: 2,
      diagnostic: error instanceof Error ? error.message : "worker-hook-failed",
    };
  }
}

async function checkWorkerEvent(
  event: WorkerHookEvent,
  policy: WorkerHookPolicy,
): Promise<void> {
  if (event.event === "Stop" && event.active) return;
  if (event.event === "Stop") return checkWorkerSources(policy);
  const file = await workerEditFile(event.file, policy);
  if (!sourceExtensions.includes(extname(file))) return;
  if (event.event === "PostToolUse") return checkWorkerSources(policy);
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
