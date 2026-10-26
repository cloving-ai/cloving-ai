import type { WatchPrSettings } from "./watch-pr-settings.ts";
import { randomUUID } from "node:crypto";
import packageMetadata from "#package" with { type: "json" };
import { redactImport } from "../chats/redact-import.ts";
import { emptyCounts } from "../chats/redaction.ts";
import { importChats } from "../chats/import.ts";
import { parseInvocation, type Invocation } from "./arguments.ts";
import { phoneCommand } from "./phone-command.ts";
import { runtimeCommand } from "./commands.ts";
import { clientCommand, runtimeDirectory } from "./runtime-directory.ts";
import {
  chatsRedactUsage,
  chatsImportUsage,
  phoneUsage,
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
  context: {
    readonly watchPr?: WatchPrSettings;
    readonly repository: string | undefined;
  } = { repository: undefined },
): Promise<void> {
  const repository = context.repository;
  const invocation = parseInvocation(argumentsList);
  if (refusedInvocation(invocation, repository)) return;
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
      runtimeDirectory: runtimeDirectory(process.env, repository),
      terminal,
    });
  } else if (invocation.kind === "chats-redact") {
    await redactionCommand(invocation.importId, repository);
  } else if (invocation.kind === "chats-import") {
    const result = await importChats({
      ...invocation,
      workingDirectory: process.cwd(),
      runtimeDirectory: runtimeDirectory(process.env, repository),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.code === "import-complete" ? 0 : 1;
  } else {
    process.exitCode = await runtimeCommand(invocation, {
      runtimeDirectory: runtimeDirectory(process.env, repository),
      ...watchSettings(context.watchPr),
      client: clientCommand(process.env, repository),
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

function refusedInvocation(
  invocation: Invocation,
  repository: string | undefined,
): boolean {
  if (refuseChatPlatform(invocation)) return true;
  if (invocation.kind !== "chats-import" && invocation.kind !== "chats-redact")
    return false;
  if (runtimeDirectory(process.env, repository) !== undefined) return false;
  process.stdout.write(
    `${JSON.stringify({ code: "repository-unknown", detail: "Change to the service repository, use --repository <directory>, or set CLOVING_RUNTIME_DIR." })}\n`,
  );
  process.exitCode = 1;
  return true;
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

function refuseChatPlatform(invocation: Invocation): boolean {
  if (process.platform === "darwin") return false;
  if (invocation.kind !== "chats-import" && invocation.kind !== "chats-redact")
    return false;
  process.stdout.write(`${JSON.stringify({ code: "platform-unsupported" })}\n`);
  process.stderr.write("platform-unsupported: Chat commands require macOS.\n");
  process.exitCode = 1;
  return true;
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

async function redactionCommand(
  importId: string,
  repository?: string,
): Promise<void> {
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
    runtimeDirectory: runtimeDirectory(process.env, repository),
    settings: { home: process.env["HOME"] || null, privateTexts },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.code === "redaction-complete" ? 0 : 1;
}
