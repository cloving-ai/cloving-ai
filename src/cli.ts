#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import packageMetadata from "#package" with { type: "json" };
import { parseInvocation } from "./cli/arguments.ts";
import { runtimeCommand } from "./cli/commands.ts";
import { runtimeDirectory } from "./cli/runtime-directory.ts";
import { usage, validateUsage } from "./cli/usage.ts";
import { validateWorkflow, type ValidationReport } from "./cli/validate.ts";

const invocation = parseInvocation(process.argv.slice(2));

if (invocation.kind === "usage-error") {
  if (invocation.json)
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, kind: "usage-error", code: invocation.code })}\n`,
    );
  else
    process.stderr.write(`${invocation.code}: run cloving --help for usage.\n`);
  process.exitCode = 2;
} else if (invocation.kind === "validate") {
  const report = await validateWorkflow(process.cwd(), invocation);
  present(report, invocation.json ? "json" : "human");
  process.exitCode = report.status === "valid" ? 0 : 1;
} else if (invocation.kind === "version") {
  process.stdout.write(`${packageMetadata.version}\n`);
} else if (invocation.kind === "help") {
  process.stdout.write(usage);
} else if (invocation.kind === "validate-help") {
  process.stdout.write(validateUsage);
} else {
  process.exitCode = await runtimeCommand(invocation, {
    runtimeDirectory: runtimeDirectory(process.env),
    workingDirectory: process.cwd(),
    terminal: {
      out: (text) => process.stdout.write(text),
      error: (text) => process.stderr.write(text),
    },
    identifier: randomUUID,
    interrupted: () =>
      new Promise((settle) => {
        for (const signal of ["SIGINT", "SIGTERM"] as const)
          process.once(signal, () => {
            settle();
          });
      }),
  });
}

function present(report: ValidationReport, format: "json" | "human"): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  if (report.status === "valid") {
    process.stdout.write(
      `Workflow ${report.workflow.name} is valid.\nWorkflow ID: ${report.workflow.workflowId}\nPinned identity: ${report.pinnedIdentity}\n`,
    );
    return;
  }
  for (const error of report.errors)
    process.stderr.write(`${error.code}: ${error.file}: ${error.detail}\n`);
}
