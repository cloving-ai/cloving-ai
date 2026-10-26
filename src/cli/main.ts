import type { WatchPrSettings } from "./watch-pr-settings.ts";
import { randomUUID } from "node:crypto";
import packageMetadata from "#package" with { type: "json" };
import { parseInvocation, type Invocation } from "./arguments.ts";
import { phoneCommand } from "./phone-command.ts";
import { runtimeCommand } from "./commands.ts";
import { clientCommand, runtimeDirectory } from "./runtime-directory.ts";
import { phoneUsage, usage, validateUsage } from "./usage.ts";
import { validateWorkflow, type ValidationReport } from "./validate.ts";

const helpTexts = {
  help: usage,
  version: `${packageMetadata.version}\n`,
  "validate-help": validateUsage,
  "phone-help": phoneUsage,
};

function helpInvocation(
  invocation: Invocation,
): invocation is Extract<
  Invocation,
  { readonly kind: keyof typeof helpTexts }
> {
  return Object.hasOwn(helpTexts, invocation.kind);
}

export async function main(
  argumentsList: readonly string[],
  watchPr?: WatchPrSettings,
): Promise<void> {
  const invocation = parseInvocation(argumentsList);
  if (helpInvocation(invocation)) {
    process.stdout.write(helpTexts[invocation.kind]);
    return;
  }

  if (invocation.kind === "usage-error") {
    presentUsageError(invocation);
  } else if (invocation.kind === "validate") {
    await validationCommand(invocation);
  } else if (invocation.kind === "phone") {
    process.exitCode = await phoneCommand(invocation, {
      runtimeDirectory: runtimeDirectory(process.env),
      terminal,
    });
  } else {
    process.exitCode = await runtimeCommand(invocation, {
      runtimeDirectory: runtimeDirectory(process.env),
      ...watchSettings(watchPr),
      client: clientCommand(process.env),
      workingDirectory: process.cwd(),
      terminal,
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

const terminal = {
  out: (text: string) => process.stdout.write(text),
  error: (text: string) => process.stderr.write(text),
};

function watchSettings(watchPr: WatchPrSettings | undefined): {
  readonly watchActions?: string;
  readonly watchPr?: WatchPrSettings;
} {
  const watchActions = process.env["CLOVING_WATCH_ACTIONS"];
  return {
    ...(watchActions === undefined ? {} : { watchActions }),
    ...(watchPr === undefined ? {} : { watchPr }),
  };
}

function presentUsageError(
  invocation: Extract<Invocation, { kind: "usage-error" }>,
): void {
  if (invocation.json)
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, kind: "usage-error", code: invocation.code })}\n`,
    );
  else
    process.stderr.write(`${invocation.code}: run cloving --help for usage.\n`);
  process.exitCode = 2;
}

async function validationCommand(
  invocation: Extract<Invocation, { kind: "validate" }>,
): Promise<void> {
  const report = await validateWorkflow(process.cwd(), invocation);
  present(report, invocation.json ? "json" : "human");
  process.exitCode = report.status === "valid" ? 0 : 1;
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
