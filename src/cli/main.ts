import { randomUUID } from "node:crypto";
import packageMetadata from "#package" with { type: "json" };
import { parseInvocation } from "./arguments.ts";
import { runtimeCommand } from "./commands.ts";
import { clientCommand, runtimeDirectory } from "./runtime-directory.ts";
import { usage, validateUsage } from "./usage.ts";
import { validateWorkflow, type ValidationReport } from "./validate.ts";

export async function main(argumentsList: readonly string[]): Promise<void> {
  const invocation = parseInvocation(argumentsList);

  if (invocation.kind === "usage-error") {
    if (invocation.json)
      process.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, kind: "usage-error", code: invocation.code })}\n`,
      );
    else
      process.stderr.write(
        `${invocation.code}: run cloving --help for usage.\n`,
      );
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
      client: clientCommand(process.env),
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
