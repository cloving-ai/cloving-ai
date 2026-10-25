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
import { chatsWorker, type ChatsWorker } from "./chats-worker.ts";
import { commandWorker, type CommandWorker } from "./command-worker.ts";
import { handoffWorker } from "./handoff-worker.ts";
import type { EffectDelivery } from "./delivery-router.ts";
import type { TurnProfiles } from "../turn-profile.ts";
import type { TokenPrices } from "../token-prices.ts";
import type { LocalCommands } from "../command-settings.ts";
import type { DeclaredWorkflow } from "../workflow-declaration.ts";
import type { WorkflowRefusal } from "../workflow-refusals.ts";
import type { Worker } from "./claude-turn.ts";
import type { DeliveryIntent } from "../broker/actor/delivery-intents.ts";

export interface DaemonSettings {
  readonly commands?: LocalCommands;
  readonly commandSeconds?: number;
  readonly fallbackModels?: readonly string[];
  readonly tokenPrices?: TokenPrices;
  readonly worker?: Worker;
  readonly profiles?: TurnProfiles;
  readonly directory: string;
  readonly runtimeDirectory: string;
  readonly repository: string;
  readonly bundleDigest?: string;
  readonly manifests: Readonly<Record<string, string | undefined>>;
  readonly declarations?: readonly DeclaredWorkflow[];
  readonly workflowRefusals?: readonly WorkflowRefusal[];
  readonly workflows: Readonly<Record<string, WorkflowFunction | undefined>>;
  readonly handler: WorkflowHandler;
  readonly loadBundle?: WorkflowBundleLoader;
  readonly command: readonly string[];
  readonly ticketCommand?: readonly string[];
  readonly nextCommand?: readonly string[];
  readonly notifyCommand?: readonly string[];
  readonly notifyMilliseconds?: number;
  readonly queueMilliseconds?: number;
  readonly queueLanes?: number;
  readonly resetQueue?: boolean;
  readonly githubCommand?: readonly string[];
  readonly checkCommand?: readonly string[];
  readonly privateTexts?: readonly string[];
  readonly concurrency: number;
}

export interface Adapters {
  readonly worker: ClaudeWorker;
  readonly github: GithubWorker;
  readonly runs: StartDelivery;
  readonly chats: ChatsWorker;
  readonly handoff: EffectDelivery;
  readonly commands: CommandWorker;
}

function githubOf(
  settings: DaemonSettings,
  given: Promise<HostPorts>,
): GithubWorker {
  const { directory, repository, checkCommand } = settings;
  return githubWorker({
    document: async (digest) => (await given).document(digest),
    report: async (effect) => (await given).reportEffect(effect),
    operationStatus: async (operationId) =>
      (await (await given).operation(operationId))?.status,
    runStatus: async (runId) =>
      (await (await given).state()).runs[runId]?.status,
    repository,
    gh: settings.githubCommand ?? ["gh"],
    worktrees: join(directory, "worktrees"),
    journal: join(directory, "github"),
    ...(settings.privateTexts === undefined
      ? {}
      : { privateTexts: settings.privateTexts }),
    ...(checkCommand === undefined ? {} : { check: checkCommand }),
  });
}

export function adapters(
  settings: DaemonSettings,
  options: {
    readonly given: Promise<HostPorts>;
    readonly generations: ReturnType<typeof workflowGenerations>;
  },
): Adapters {
  const { directory, repository, command } = settings;
  const { given, generations } = options;
  const document = async (digest: string): Promise<string | undefined> =>
    (await given).document(digest);
  const report = async (
    effect: Parameters<HostPorts["reportEffect"]>[0],
  ): Promise<unknown> => (await given).reportEffect(effect);
  const worker = claudeWorker({
    fallbackModels: settings.fallbackModels ?? [],
    tokenPrices: settings.tokenPrices ?? {},
    worker: settings.worker ?? "claude",
    profiles: settings.profiles ?? {},
    workflowId: async (runId) => (await given).workflow.id(runId),
    repository,
    command,
    document,
    report,
    worktrees: join(directory, "worktrees"),
    journal: join(directory, "journal"),
  });
  const github = githubOf(settings, given);
  const chats = chatsWorker({
    runtimeDirectory: settings.runtimeDirectory,
    document,
    workflowId: async (runId) => (await given).workflow.id(runId),
  });
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
  const commands = commandWorker({
    repository,
    journal: join(directory, "commands"),
    commands: settings.commands ?? {},
    seconds: settings.commandSeconds ?? 60,
    document,
    report,
  });
  return { worker, github, runs, chats, handoff, commands };
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
  const state = await ports.state();
  const calls: DeliveryIntent[] = [];
  for (const run of Object.values(state.runs)) {
    for (const operation of await ports.operations(run.runId)) {
      if (
        operation.capability !== "command" ||
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
  await commands.recover(calls);
}
