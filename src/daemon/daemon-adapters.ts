import { turnRecoveries, type TurnRecoveries } from "../turn-recovery.ts";
import type { ThreadPoolSettings } from "../cli/thread-pool.ts";
import type { HostSignals, QueueLimits } from "../queue-room.ts";
import { join } from "node:path";
import {
  startDelivery,
  type StartDelivery,
  type WorkflowFunction,
} from "../host/start-delivery.ts";
import type { WorkflowHandler } from "../host/world-host.ts";
import { cancelled, taggedRuns } from "../host/world-runs.ts";
import type { HostPorts } from "../service/service.ts";
import {
  workflowGenerations,
  type WorkflowBundleLoader,
} from "./workflow-generations.ts";
import { claudeWorker, type ClaudeWorker } from "./claude-worker.ts";
import { githubWorker, type GithubWorker } from "./github-worker.ts";
import {
  commandWorker,
  type CommandWorker,
  type CommandWorkerSettings,
} from "./command-worker.ts";
import { handoffWorker } from "./handoff-worker.ts";
import type { EffectDelivery } from "./delivery-router.ts";
import type { TurnProfiles } from "../turn-profile.ts";
import type { TokenPrices } from "../token-prices.ts";
import type { LocalCommands } from "../command-settings.ts";
import type { DeclaredWorkflow } from "../workflow-declaration.ts";
import type { WorkflowRefusal } from "../workflow-refusals.ts";
import type { HarnessSettings } from "../harness-defaults.ts";
import type { ProtectedIntent } from "../broker/actor/delivery-intents.ts";
import { resumableHarness } from "./claude-recovery.ts";
import type { RetentionSettings } from "../record-retention.ts";
import type { MergeMode } from "../merge-mode.ts";
import { clovingVersion } from "../cli/toolchain.ts";
import type { RecordedSource } from "../project-settings.ts";
import type { RunWaitChecks } from "../run-wait.ts";
import {
  turnSettingsSource,
  type SettingDigests,
  type TurnSettingsSource,
} from "./settings-reload.ts";

export interface DaemonSettings extends HarnessSettings {
  readonly commands?: LocalCommands;
  readonly commandSeconds?: number;
  readonly fallbackModels?: readonly string[];
  readonly tokenPrices?: TokenPrices;
  readonly profiles?: TurnProfiles;
  readonly settingDigests?: SettingDigests;
  readonly directory: string;
  readonly runtimeDirectory: string;
  readonly repository: string;
  readonly commit?: string | null;
  readonly settingSources?: Readonly<Record<string, RecordedSource>>;
  readonly bundleDigest?: string;
  readonly manifests: Readonly<Record<string, string | undefined>>;
  readonly declarations?: readonly DeclaredWorkflow[];
  readonly workflowRefusals?: readonly WorkflowRefusal[];
  readonly workflows: Readonly<Record<string, WorkflowFunction | undefined>>;
  readonly handler: WorkflowHandler;
  readonly loadBundle?: WorkflowBundleLoader;
  readonly reloadCommand?: readonly string[];
  readonly command: readonly string[];
  readonly ticketCommand?: readonly string[];
  readonly nextCommand?: readonly string[];
  readonly readyCommand?: readonly string[];
  readonly notifyCommand?: readonly string[];
  readonly notifyMilliseconds?: number;
  readonly queueMilliseconds?: number;
  readonly runWaitChecks?: RunWaitChecks;
  readonly scheduleClock?: () => number;
  readonly retention?: RetentionSettings;
  readonly retentionClock?: () => number;
  readonly schedules?: unknown;
  readonly queueLanes?: number;
  readonly queueLimits?: QueueLimits;
  readonly hostSignals?: () => Promise<HostSignals>;
  readonly queueDailySpendLimitUsd?: number;
  readonly spendScope?: "queue" | "all";
  readonly resetQueue?: boolean;
  readonly githubCommand?: readonly string[];
  readonly requiredChecks?: readonly string[] | null;
  readonly checkCommand?: readonly string[];
  readonly mergeMode?: MergeMode;
  readonly privateTexts?: readonly string[];
  readonly threadPool?: ThreadPoolSettings;
  readonly concurrency: number;
}

export interface Adapters {
  readonly worker: ClaudeWorker;
  readonly turnSettings: TurnSettingsSource;
  readonly github: GithubWorker;
  readonly runs: StartDelivery;
  readonly handoff: EffectDelivery;
  readonly commands: CommandWorker;
  readonly recoveries: TurnRecoveries;
}

function githubOf(
  settings: DaemonSettings,
  given: Promise<HostPorts>,
): GithubWorker {
  const { directory, repository, checkCommand } = settings;
  return githubWorker({
    document: async (digest) => (await given).document(digest),
    report: async (effect) => (await given).reportEffect(effect),
    observe: async (observation) =>
      (await given).submit({ kind: "report-observation", ...observation }),
    operationStatus: async (operationId) =>
      (await (await given).operation(operationId))?.status,
    runStatus: async (runId) =>
      (await (await given).state()).runs[runId]?.status,
    repository,
    gh: settings.githubCommand ?? ["gh"],
    ...(settings.requiredChecks === undefined
      ? {}
      : { requiredChecks: settings.requiredChecks }),
    worktrees: join(directory, "worktrees"),
    journal: join(directory, "github"),
    ...(settings.privateTexts === undefined
      ? {}
      : { privateTexts: settings.privateTexts }),
    ...(checkCommand === undefined ? {} : { check: checkCommand }),
    ...(settings.mergeMode === undefined
      ? {}
      : { mergeMode: settings.mergeMode }),
  });
}

function workerHarness(settings: DaemonSettings) {
  return {
    worker: settings.worker ?? settings.harness?.name ?? "claude",
    workerCommands: settings.workerCommands ?? {},
    harness: settings.harness ?? {},
    shell: settings.shell ?? process.env["SHELL"] ?? "/bin/sh",
    command: settings.command,
    turnVariables: settings.turnVariables ?? [],
  };
}

export function adapters(
  settings: DaemonSettings,
  options: {
    readonly given: Promise<HostPorts>;
    readonly generations: ReturnType<typeof workflowGenerations>;
  },
): Adapters {
  const { directory, repository } = settings;
  const { given, generations } = options;
  const document = async (digest: string): Promise<string | undefined> =>
    (await given).document(digest);
  const report = async (
    effect: Parameters<HostPorts["reportEffect"]>[0],
  ): Promise<unknown> => (await given).reportEffect(effect);
  const turnSettings = turnSettingsSource({
    profiles: settings.profiles ?? {},
    fallbackModels: settings.fallbackModels ?? [],
    tokenPrices: settings.tokenPrices ?? {},
  });
  const recoveries = turnRecoveries();
  const worker = claudeWorker({
    ...workerHarness(settings),
    recovered: recoveries.note,
    turnSettings: turnSettings.current,
    workflowId: async (runId) => (await given).workflow.id(runId),
    repository,
    document,
    report,
    notes: {
      read: async (runId) => (await given).notes.read(runId),
      operations: async (runId) =>
        (await (await given).operations(runId))
          .filter((operation) => operation.capability === "claude")
          .map((operation) => operation.operationId),
    },
    worktrees: join(directory, "worktrees"),
    journal: join(directory, "journal"),
    log: process.stderr.write.bind(process.stderr),
  });
  const github = githubOf(settings, given);
  const runs = startDelivery({
    document,
    runs: taggedRuns,
    cancel: cancelled,
    input: async (runId) => (await given).input(runId),
    workflow: async ({ runId }) =>
      (await generations.resolve(await (await given).workflow.manifest(runId)))
        ?.workflow,
  });
  const handoff = handoffOf(settings, given);
  const commands = commandsOf(settings, {
    document,
    report,
    recovered: recoveries.note,
  });
  return { worker, github, runs, handoff, commands, turnSettings, recoveries };
}

function commandsOf(
  settings: DaemonSettings,
  effects: Pick<CommandWorkerSettings, "document" | "report" | "recovered">,
): CommandWorker {
  return commandWorker({
    repository: settings.repository,
    journal: join(settings.directory, "commands"),
    commands: settings.commands ?? {},
    seconds: settings.commandSeconds ?? 60,
    ...effects,
  });
}

function handoffOf(
  settings: DaemonSettings,
  given: Promise<HostPorts>,
): EffectDelivery {
  return handoffWorker({
    runtimeDirectory: settings.runtimeDirectory,
    journal: join(settings.directory, "handoffs"),
    document: async (digest) => (await given).document(digest),
    runStatus: async (runId) =>
      (await (await given).state()).runs[runId]?.status,
  });
}

export async function recoverCommands(
  commands: CommandWorker,
  ports: HostPorts,
): Promise<void> {
  await commands.recover(await recoveryCalls(ports, "command"));
}

export async function recoverClaude(
  worker: Pick<ClaudeWorker, "harness" | "recover">,
  ports: Pick<HostPorts, "state" | "operations">,
): Promise<void> {
  for (const intent of await recoveryCalls(ports, "claude")) {
    if (!resumableHarness(await worker.harness(intent.operationId))) continue;
    if (!(await stillRecoverable(ports, intent))) continue;
    await worker.recover(intent);
  }
}

async function stillRecoverable(
  ports: Pick<HostPorts, "state" | "operations">,
  intent: ProtectedIntent,
): Promise<boolean> {
  const operation = (await ports.operations(intent.runId)).find(
    (current) => current.operationId === intent.operationId,
  );
  const run = (await ports.state()).runs[intent.runId];
  return (
    run?.status === "running" &&
    operation !== undefined &&
    operation.leaseGeneration === intent.leaseGeneration &&
    ["running", "recovering", "dispatch-pending"].includes(operation.status)
  );
}

async function recoveryCalls(
  ports: Pick<HostPorts, "state" | "operations">,
  capability: "command" | "claude",
): Promise<readonly ProtectedIntent[]> {
  const state = await ports.state();
  const calls: ProtectedIntent[] = [];
  for (const run of Object.values(state.runs)) {
    if (capability === "claude" && run.status !== "running") continue;
    for (const operation of await ports.operations(run.runId)) {
      if (
        operation.capability !== capability ||
        operation.leaseGeneration === null ||
        !["running", "recovering", "dispatch-pending"].includes(
          operation.status,
        )
      )
        continue;
      calls.push({
        ...operation,
        kind: "protected-effect",
        purpose: "reconcile",
        workflow: run.workflow,
        leaseGeneration: operation.leaseGeneration,
      });
    }
  }
  return calls;
}

export function daemonIdentity(settings: DaemonSettings) {
  return {
    version: clovingVersion,
    commit: settings.commit ?? null,
    startedAt: new Date().toISOString(),
    ...(settings.settingSources === undefined
      ? {}
      : { settingSources: settings.settingSources }),
  };
}
