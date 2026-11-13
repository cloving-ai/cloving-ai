import type { WatchPrSettings } from "./watch-pr-settings.ts";
import type { WatchThemeSettings } from "./watch-themes.ts";
import { themeFolders } from "./theme-folders.ts";
import { initPromptCommand } from "./init-prompt-command.ts";
import type { HarnessStartRequest } from "../harness-start.ts";
import { initCommand } from "./init-command.ts";
import { configCommand } from "./config-command.ts";
import type { ProbeRunner } from "./probe-command.ts";
import { doctorCommand } from "./doctor.ts";
import { randomUUID } from "node:crypto";
import packageMetadata from "#package" with { type: "json" };
import { parseInvocation, type Invocation } from "./arguments.ts";
import { phoneCommand } from "./phone-command.ts";
import { runtimeCommand, type CommandEnvironment } from "./commands.ts";
import { workspaceCommand } from "./workspace-status.ts";
import type { RuntimeInvocation } from "./runtime-invocation.ts";
import type { WorkspaceRecord } from "./workspace-record.ts";
import { themesCommand } from "./themes-command.ts";
import { channelSource, refusedPrivateTexts } from "./mcp-channel.ts";
import { mcpServer } from "./mcp-server.ts";
import { workspaceMcpServer } from "./mcp-workspace.ts";
import { clientCommand, runtimeDirectory } from "./runtime-directory.ts";
import {
  commandUsage,
  configUsage,
  phoneUsage,
  usage,
  validateUsage,
} from "./usage.ts";
import { validateWorkflow, type ValidationReport } from "./validate.ts";
import { retentionSettings } from "../record-retention.ts";

const helpTexts = {
  help: usage,
  version: `${packageMetadata.version}\n`,
  "validate-help": validateUsage,
  "phone-help": phoneUsage,
  "init-help": String(commandUsage["init"]),
  "init-prompt-help": String(commandUsage["init-prompt"]),
  "doctor-help": String(commandUsage["doctor"]),
  "config-help": configUsage,
  "mcp-help": String(commandUsage["mcp"]),
  "themes-help": String(commandUsage["themes"]),
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
    readonly startHarness?: (
      request: HarnessStartRequest,
    ) => Promise<number | null>;
    readonly applyLocal?: (repository: string) => Promise<number>;
    readonly environment?: Readonly<NodeJS.ProcessEnv>;
    readonly repository: string | undefined;
    readonly workspace?: WorkspaceRecord | undefined;
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
  } else if (isInspection(invocation)) {
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
  } else if (invocation.kind === "mcp") {
    process.exitCode = await mcpCommand(invocation, context);
  } else {
    process.exitCode = await serviceCommand(invocation, {
      ...context,
      environment,
    });
  }
}

function mcpCommand(
  invocation: Extract<Invocation, { readonly kind: "mcp" }>,
  context: {
    readonly repository: string | undefined;
    readonly workspace?: WorkspaceRecord | undefined;
  },
): Promise<number> {
  if (invocation.workspace === true)
    return workspaceMcpServer(context.workspace, invocation);
  const { repository } = context;
  const runtime = runtimeDirectory(process.env, repository);
  if (invocation.channel === undefined || runtime === undefined)
    return mcpServer(runtime);
  const source = channelSource(process.env, {
    runtimeDirectory: runtime,
    repository,
  });
  return source === undefined
    ? refusedPrivateTexts()
    : mcpServer(runtime, { channel: [source] });
}

function serviceCommand(
  invocation: RuntimeInvocation & { readonly repository?: string },
  context: {
    readonly watchPr?: WatchPrSettings | undefined;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly repository: string | undefined;
    readonly workspace?: WorkspaceRecord | undefined;
  },
): Promise<number> {
  const { repository, environment } = context;
  const commandEnvironment: CommandEnvironment = {
    runtimeDirectory: runtimeDirectory(process.env, repository),
    ...watchSettings({ watchPr: context.watchPr, environment, repository }),
    client: clientCommand(process.env, { repository }),
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
  };
  return (
    workspaceCommand(invocation, {
      ...commandEnvironment,
      workspace: context.workspace,
      selected: invocation.repository,
      repository,
      variables: process.env,
    }) ?? runtimeCommand(invocation, commandEnvironment)
  );
}

function isInspection(
  invocation: Invocation,
): invocation is Extract<
  Invocation,
  { readonly kind: "doctor" | "init-prompt" | "init" | "themes" }
> {
  return ["doctor", "init-prompt", "init", "themes"].includes(invocation.kind);
}

async function inspectionCommand(
  invocation: Extract<
    Invocation,
    { readonly kind: "doctor" | "init-prompt" | "init" | "themes" }
  >,
  context: {
    readonly doctorProbe?: ProbeRunner;
    readonly startHarness?: (
      request: HarnessStartRequest,
    ) => Promise<number | null>;
    readonly applyLocal?: (repository: string) => Promise<number>;
    readonly repository: string | undefined;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
  },
): Promise<number> {
  if (invocation.kind === "themes")
    return await themesCommand({ ...context, json: invocation.json });
  const probe = context.doctorProbe;
  if (probe === undefined)
    throw new Error(`${invocation.kind}-probe-unavailable`);
  const options = {
    probe,
    repository: context.repository,
    environment: context.environment,
  };
  if (invocation.kind === "init")
    return await initCommand({
      ...options,
      harness: invocation.harness,
      path: invocation.path,
      applyLocal:
        context.applyLocal ??
        (() => {
          throw new Error("local-preset-unavailable");
        }),
      start:
        context.startHarness ??
        (() => {
          throw new Error("init-start-unavailable");
        }),
    });
  if (invocation.kind === "doctor")
    return await doctorCommand({ ...options, json: invocation.json });
  return await initPromptCommand(options);
}

const terminal = {
  out: (text: string) => process.stdout.write(text),
  error: (text: string) => process.stderr.write(text),
};

function watchRetentionDays(
  environment: Readonly<NodeJS.ProcessEnv>,
): number | null {
  try {
    return retentionSettings(environment).days;
  } catch {
    return null;
  }
}

function watchSettings(input: {
  readonly watchPr: WatchPrSettings | undefined;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly repository: string | undefined;
}): {
  readonly watchActions?: string;
  readonly watchPr?: WatchPrSettings;
  readonly watchThemes: WatchThemeSettings;
  readonly retentionDays: number | null;
} {
  const { watchPr, environment } = input;
  const watchActions = environment["CLOVING_WATCH_ACTIONS"];
  return {
    ...(watchActions === undefined ? {} : { watchActions }),
    retentionDays: watchRetentionDays(environment),
    ...(watchPr === undefined ? {} : { watchPr }),
    watchThemes: {
      setting: environment["CLOVING_WATCH_THEME"] ?? "auto",
      folders: themeFolders({
        repository:
          environment["CLOVING_WATCH_REPOSITORY"] ??
          input.repository ??
          process.cwd(),
        environment,
      }),
    },
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
