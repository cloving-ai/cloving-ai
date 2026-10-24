import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  startDelivery,
  type StartDelivery,
  type WorkflowFunction,
} from "../host/start-delivery.ts";
import {
  registerStepBridge,
  sdkStepCall,
  stepBridge,
} from "../host/step-bridge-host.ts";
import { startHost, type WorkflowHandler } from "../host/world-host.ts";
import { worldLoop } from "../host/world-reconciliation.ts";
import {
  cancelled,
  workflowOutcome,
  taggedRun,
  taggedRuns,
} from "../host/world-runs.ts";
import {
  startService,
  type HostPorts,
  type Service,
  type ServiceHost,
} from "../service/service.ts";
import {
  workflowGenerations,
  type WorkflowBundleLoader,
} from "./workflow-generations.ts";
import { claudeWorker, type ClaudeWorker } from "./claude-worker.ts";
import type { TurnProfiles } from "../turn-profile.ts";
import type { TokenPrices } from "../token-prices.ts";
import type { DeclaredWorkflow } from "../workflow-declaration.ts";
import type { WorkflowRefusal } from "../workflow-refusals.ts";
import type { Worker } from "./claude-turn.ts";
import { deliveryRouter, type EffectDelivery } from "./delivery-router.ts";
import { handoffWorker } from "./handoff-worker.ts";
import { githubWorker, type GithubWorker } from "./github-worker.ts";
import { chatsWorker, type ChatsWorker } from "./chats-worker.ts";
import { worldDirectory } from "./host-environment.ts";
import { pinnedWorkflowHandler } from "./workflow-replay.ts";
import { issueQueue } from "./issue-queue.ts";
import { notifyRuns } from "./notify.ts";
import {
  ticketRegistrations,
  ticketRegistrationTable,
} from "./ticket-registration.ts";

export interface DaemonSettings {
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

export interface Daemon {
  readonly socket: string;
  readonly close: () => Promise<void>;
}

export type DaemonOpening =
  | { readonly kind: "started"; readonly daemon: Daemon }
  | {
      readonly kind: "refused";
      readonly reason: string;
      readonly detail: string;
    };

export const turnLeaseMilliseconds = 4 * 3_600_000;
export const loopMilliseconds = 250;
export const bridgeTiming = {
  lookupTries: 250,
  pollMilliseconds: 250,
  retryMilliseconds: 1_000,
};

async function hosted(
  settings: DaemonSettings,
  hosting: {
    readonly ports: HostPorts;
    readonly generations: ReturnType<typeof workflowGenerations>;
  },
): Promise<ServiceHost> {
  const { ports, generations } = hosting;
  const opening = await startHost({
    dataDirectory: worldDirectory(settings.directory),
    concurrency: settings.concurrency,
    handler: pinnedWorkflowHandler(
      async (request, runId) => {
        const generation = await generations.resolve(
          await ports.workflow.manifest(runId),
        );
        return generation === undefined
          ? new Response("pinned-workflow-unavailable", { status: 503 })
          : generation.handler(request);
      },
      {
        state: ports.state,
        run: taggedRun,
        available: ports.workflow.available,
        submit: ports.submit,
      },
    ),
  });
  if (opening.kind === "refused")
    throw new Error(`${opening.reason}: ${opening.detail}`);
  const loop = worldLoop({
    ...ports,
    runs: taggedRuns,
    outcome: workflowOutcome,
    intervalMilliseconds: loopMilliseconds,
  });
  const stopping = new AbortController();
  const remove = registerStepBridge(
    stepBridge({
      ...ports,
      run: taggedRun,
      call: sdkStepCall,
      stopped: stopping.signal,
      timing: bridgeTiming,
    }),
  );
  return {
    reports: loop.reports,
    close: async () => {
      stopping.abort();
      remove();
      await loop.stop();
      await opening.host.close();
    },
  };
}

interface Adapters {
  readonly worker: ClaudeWorker;
  readonly github: GithubWorker;
  readonly runs: StartDelivery;
  readonly chats: ChatsWorker;
  readonly handoff: EffectDelivery;
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

function adapters(
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
  return { worker, github, runs, chats, handoff };
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

async function daemonRegistrations(settings: DaemonSettings) {
  const table = ticketRegistrationTable(
    {
      repository: settings.repository,
      command: settings.ticketCommand,
      nextCommand: settings.nextCommand,
      githubCommand: settings.githubCommand,
    },
    settings.declarations,
  );
  const admitted = await ticketRegistrations(settings.manifests, {
    table,
    ...(settings.bundleDigest === undefined
      ? {}
      : { bundleDigest: settings.bundleDigest }),
  });
  return {
    table,
    admitted:
      admitted.kind === "rejected"
        ? admitted
        : {
            ...admitted,
            registrations: admitted.registrations.map((registration) => ({
              ...registration,
              ...(settings.queueMilliseconds !== undefined &&
              registration.workflowId === "develop-issue"
                ? { admission: settings.queueLanes ?? 1 }
                : {}),
            })),
          },
  };
}

export async function startDaemon(
  givenSettings: DaemonSettings,
): Promise<DaemonOpening> {
  const settings = {
    ...givenSettings,
    repository: await realpath(givenSettings.repository),
  };
  const { table, admitted } = await daemonRegistrations(settings);
  if (admitted.kind === "rejected")
    return {
      kind: "refused",
      reason: "workflow-rejected",
      detail: admitted.detail,
    };
  const given = Promise.withResolvers<HostPorts>();
  const generations = workflowGenerations({
    ...settings,
    registrations: admitted.registrations,
    table,
  });
  const { worker, github, runs, chats, handoff } = adapters(settings, {
    given: given.promise,
    generations,
  });
  await mkdir(join(settings.directory, "state"), { recursive: true });
  await mkdir(settings.runtimeDirectory, { recursive: true, mode: 0o700 });
  const opening = await startService({
    stateDirectory: join(settings.directory, "state"),
    runtimeDirectory: settings.runtimeDirectory,
    workflowBundles: {
      directory: join(settings.directory, "workflow-bundles"),
      repository: settings.repository,
    },
    workflowRefusals: settings.workflowRefusals ?? [],
    workflows: admitted.registrations,
    retainedWorkflow: generations.available,
    delivery: deliveryRouter({
      runs,
      effects: { claude: worker, github, chats, handoff },
    }),
    effects: { leaseMilliseconds: turnLeaseMilliseconds },
    host: (ports) => {
      given.resolve(ports);
      return hosted(settings, { ports, generations });
    },
  });
  if (opening.kind === "refused") {
    await Promise.all([worker.close(), github.close(), chats.close()]);
    return opening;
  }
  return {
    kind: "started",
    daemon: await runningDaemon(settings, {
      service: opening.service,
      worker,
      github,
      chats,
    }),
  };
}

async function runningDaemon(
  settings: DaemonSettings,
  resources: {
    readonly service: Service;
    readonly worker: ClaudeWorker;
    readonly github: GithubWorker;
    readonly chats: ChatsWorker;
  },
): Promise<Daemon> {
  const { service, worker, github, chats } = resources;
  await github.scan();
  const notifier =
    settings.notifyCommand === undefined
      ? undefined
      : await notifyRuns({
          directory: settings.directory,
          runtimeDirectory: settings.runtimeDirectory,
          command: settings.notifyCommand,
          ...(settings.notifyMilliseconds === undefined
            ? {}
            : { intervalMilliseconds: settings.notifyMilliseconds }),
        }).catch(async (error: unknown) => {
          await Promise.all([worker.close(), github.close(), chats.close()]);
          await service.close();
          throw error;
        });
  const queue =
    settings.queueMilliseconds === undefined
      ? undefined
      : issueQueue({
          directory: settings.directory,
          runtimeDirectory: settings.runtimeDirectory,
          intervalMilliseconds: settings.queueMilliseconds,
          lanes: settings.queueLanes ?? 1,
          resetQueue: settings.resetQueue ?? false,
        });
  return {
    socket: service.socket,
    close: async () => {
      await notifier?.stop();
      await queue?.stop();
      await Promise.all([worker.close(), github.close(), chats.close()]);
      await service.close();
    },
  };
}
