#!/usr/bin/env node
import packageMetadata from "#package" with { type: "json" };
import { parseInvocation } from "./cli/arguments.ts";
import { validateWorkflow, type ValidationReport } from "./cli/validate.ts";

const usage = `Usage: cloving [--help] [--version]
       cloving workflows validate <manifest-path> [--input <json-file>] [--json]

Commands:
  workflows validate  Check a compiled workflow manifest, its artifacts and optional runtime input.

Use npm exec -- cloving ... for a project-local installation.
`;

const validateUsage = `Usage: cloving workflows validate <manifest-path> [--input <json-file>] [--json]

Checks a Cloving workflow manifest, its compiled SDK artifacts, declared resources and toolchain, and an optional runtime input file. Relative paths resolve against the current directory.

Options:
  --input <json-file>  Validate this runtime input file.
  --json               Print one versioned JSON result on stdout.

Validation does not admit a run, dispatch effects, import workflow code or call a model.

Example:
  cloving workflows validate cloving.workflow.json --input input.json
`;

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
  const report = await validateWorkflow(
    process.cwd(),
    invocation.manifest,
    invocation.input,
  );
  present(report, invocation.json ? "json" : "human");
  process.exitCode = report.status === "valid" ? 0 : 1;
} else if (invocation.kind === "version") {
  process.stdout.write(`${packageMetadata.version}\n`);
} else {
  process.stdout.write(invocation.kind === "help" ? usage : validateUsage);
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
