import type { WatchPrSettings } from "./watch-pr-settings.ts";
import { randomUUID } from "node:crypto";
import packageMetadata from "#package" with { type: "json" };
import { redactImport } from "../chats/redact-import.ts";
import { emptyCounts } from "../chats/redaction.ts";
import { importChats } from "../chats/import.ts";
import { parseInvocation, type Invocation } from "./arguments.ts";
import { runtimeCommand } from "./commands.ts";
import { clientCommand, runtimeDirectory } from "./runtime-directory.ts";
import {
  chatsRedactUsage,
  chatsImportUsage,
  usage,
  validateUsage,
} from "./usage.ts";
import { validateWorkflow, type ValidationReport } from "./validate.ts";

const helpTexts = {
  help: usage,
  version: `${packageMetadata.version}\n`,
  "validate-help": validateUsage,
  "chats-import-help": chatsImportUsage,
  "chats-redact-help": chatsRedactUsage,
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
  } else if (invocation.kind === "chats-redact") {
    await redactionCommand(invocation.importId);
  } else if (invocation.kind === "chats-import") {
    const result = await importChats({
      ...invocation,
      workingDirectory: process.cwd(),
      runtimeDirectory: runtimeDirectory(process.env),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.code === "import-complete" ? 0 : 1;
  } else {
    process.exitCode = await runtimeCommand(invocation, {
      runtimeDirectory: runtimeDirectory(process.env),
      ...(watchPr === undefined ? {} : { watchPr }),
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

async function redactionCommand(importId: string): Promise<void> {
  let privateTexts: unknown = [];
  try {
    const setting = process.env["CLOVING_PRIVATE_TEXTS"];
    if (setting !== undefined) privateTexts = JSON.parse(setting);
    if (
      !Array.isArray(privateTexts) ||
      !privateTexts.every(
        (item: unknown): item is string =>
          typeof item === "string" && item.trim() !== "",
      )
    )
      throw new Error("invalid-settings");
  } catch {
    process.stdout.write(
      `${JSON.stringify({ code: "invalid-settings", importId, recordCount: 0, counts: emptyCounts(), totalCount: 0 })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const result = await redactImport({
    importId,
    workingDirectory: process.cwd(),
    runtimeDirectory: runtimeDirectory(process.env),
    settings: { home: process.env["HOME"] || null, privateTexts },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.code === "redaction-complete" ? 0 : 1;
}
