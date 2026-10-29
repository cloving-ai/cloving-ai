import type { WatchPrSettings } from "./watch-pr-settings.ts";
import { initPromptCommand } from "./init-prompt-command.ts";
import { configCommand } from "./config-command.ts";
import type { ProbeRunner } from "./probe-command.ts";
import { doctorCommand } from "./doctor.ts";
import { randomUUID } from "node:crypto";
import packageMetadata from "#package" with { type: "json" };
import { parseInvocation, type Invocation } from "./arguments.ts";
import { phoneCommand } from "./phone-command.ts";
import { runtimeCommand } from "./commands.ts";
import { clientCommand, runtimeDirectory } from "./runtime-directory.ts";
import {
  commandUsage,
  configUsage,
  phoneUsage,
  usage,
  validateUsage,
} from "./usage.ts";
import { validateWorkflow, type ValidationReport } from "./validate.ts";

const helpTexts = {
  help: usage,
  version: `${packageMetadata.version}\n`,
  "validate-help": validateUsage,
  "phone-help": phoneUsage,
  "init-prompt-help": String(commandUsage["init-prompt"]),
  "doctor-help": String(commandUsage["doctor"]),
  "config-help": configUsage,
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
    readonly doctorProbe?: ProbeRunner;
    readonly environment?: Readonly<NodeJS.ProcessEnv>;
    readonly repository: string | undefined;
  } = { repository: undefined },
): Promise<void> {
  const { repository, environment = process.env } = context;
  const invocation = parseInvocation(argumentsList);
  if (helpInvocation(invocation)) {
    process.stdout.write(helpTexts[invocation.kind]);
    return;
  }

  if (invocation.kind === "usage-error") {
    presentUsageError(invocation);
  } else if (invocation.kind === "validate") {
    await validationCommand(invocation);
  } else if (
    invocation.kind === "doctor" ||
    invocation.kind === "init-prompt"
  ) {
    process.exitCode = await inspectionCommand(invocation, {
      ...context,
      environment,
    });
  } else if (invocation.kind === "config") {
    process.exitCode = await configCommand(invocation, repository);
  } else if (invocation.kind === "phone") {
    process.exitCode = await phoneCommand(invocation, {
      runtimeDirectory: runtimeDirectory(process.env, repository),
      terminal,
    });
  } else {
    process.exitCode = await runtimeCommand(invocation, {
      runtimeDirectory: runtimeDirectory(process.env, repository),
      ...watchSettings(context.watchPr, environment),
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

async function inspectionCommand(
  invocation: Extract<Invocation, { readonly kind: "doctor" | "init-prompt" }>,
  context: {
    readonly doctorProbe?: ProbeRunner;
    readonly repository: string | undefined;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
  },
): Promise<number> {
  const probe = context.doctorProbe;
  if (probe === undefined)
    throw new Error(`${invocation.kind}-probe-unavailable`);
  const options = {
    probe,
    repository: context.repository,
    environment: context.environment,
  };
  if (invocation.kind === "doctor")
    return await doctorCommand({ ...options, json: invocation.json });
  return await initPromptCommand(options);
}

const terminal = {
  out: (text: string) => process.stdout.write(text),
  error: (text: string) => process.stderr.write(text),
};

function watchSettings(
  watchPr: WatchPrSettings | undefined,
  environment: Readonly<NodeJS.ProcessEnv>,
): {
  readonly watchActions?: string;
  readonly watchPr?: WatchPrSettings;
} {
  const watchActions = environment["CLOVING_WATCH_ACTIONS"];
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
