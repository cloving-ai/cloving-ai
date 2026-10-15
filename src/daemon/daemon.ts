import { mkdir } from "node:fs/promises";
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
import { claudeWorker, type ClaudeWorker } from "./claude-worker.ts";
import type { Worker } from "./claude-turn.ts";
import { deliveryRouter } from "./delivery-router.ts";
import { githubWorker, type GithubWorker } from "./github-worker.ts";
import { worldDirectory } from "./host-environment.ts";
import { issueQueue } from "./issue-queue.ts";
import {
  ticketRegistrations,
  ticketRegistrationTable,
  type TicketRegistration,
} from "./ticket-registration.ts";

export interface DaemonSettings {
  readonly worker?: Worker;
  readonly directory: string;
  readonly runtimeDirectory: string;
  readonly repository: string;
  readonly manifests: Readonly<Record<string, string | undefined>>;
  readonly workflows: Readonly<Record<string, WorkflowFunction | undefined>>;
  readonly handler: WorkflowHandler;
  readonly command: readonly string[];
  readonly ticketCommand?: readonly string[];
  readonly nextCommand?: readonly string[];
  readonly queueMilliseconds?: number;
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
  ports: HostPorts,
): Promise<ServiceHost> {
  const opening = await startHost({
    dataDirectory: worldDirectory(settings.directory),
    concurrency: settings.concurrency,
    handler: settings.handler,
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
    readonly table: readonly TicketRegistration[];
  },
): Adapters {
  const { directory, repository, command } = settings;
  const { given, table } = options;
  const workflows = Object.fromEntries(
    table.map((row) => [row.workflowId, settings.workflows[row.functionName]]),
  );
  const document = async (digest: string): Promise<string | undefined> =>
    (await given).document(digest);
  const report = async (
    effect: Parameters<HostPorts["reportEffect"]>[0],
  ): Promise<unknown> => (await given).reportEffect(effect);
  const worker = claudeWorker({
    worker: settings.worker ?? "claude",
    repository,
    command,
    document,
    report,
    worktrees: join(directory, "worktrees"),
    journal: join(directory, "journal"),
  });
  const github = githubOf(settings, given);
  const runs = startDelivery({
    document,
    runs: taggedRuns,
    cancel: cancelled,
    input: async (runId) => (await given).input(runId),
    workflow: async (runId) =>
      workflows[String(await (await given).workflowId(runId))],
  });
  return { worker, github, runs };
}

export async function startDaemon(
  settings: DaemonSettings,
): Promise<DaemonOpening> {
  const { directory } = settings;
  const table = ticketRegistrationTable({
    repository: settings.repository,
    command: settings.ticketCommand,
    nextCommand: settings.nextCommand,
  });
  const admitted = await ticketRegistrations(settings.manifests, { table });
  if (admitted.kind === "rejected")
    return {
      kind: "refused",
      reason: "workflow-rejected",
      detail: admitted.detail,
    };
  const given = Promise.withResolvers<HostPorts>();
  const { worker, github, runs } = adapters(settings, {
    given: given.promise,
    table,
  });
  const closed = async (): Promise<void> => {
    await Promise.all([worker.close(), github.close()]);
  };
  await mkdir(join(directory, "state"), { recursive: true });
  await mkdir(settings.runtimeDirectory, { recursive: true, mode: 0o700 });
  const opening = await startService({
    stateDirectory: join(directory, "state"),
    runtimeDirectory: settings.runtimeDirectory,
    workflows: admitted.registrations.map((registration) => ({
      ...registration,
      ...(settings.queueMilliseconds !== undefined &&
      registration.workflowId === "develop-issue"
        ? { admission: "when-idle" as const }
        : {}),
    })),
    delivery: deliveryRouter({
      runs,
      effects: { claude: worker, github },
    }),
    effects: { leaseMilliseconds: turnLeaseMilliseconds },
    host: (ports) => {
      given.resolve(ports);
      return hosted(settings, ports);
    },
  });
  if (opening.kind === "refused") {
    await closed();
    return opening;
  }
  return {
    kind: "started",
    daemon: await runningDaemon(settings, {
      service: opening.service,
      worker,
      github,
    }),
  };
}

async function runningDaemon(
  settings: DaemonSettings,
  resources: {
    readonly service: Service;
    readonly worker: ClaudeWorker;
    readonly github: GithubWorker;
  },
): Promise<Daemon> {
  const { service, worker, github } = resources;
  await github.scan();
  const queue =
    settings.queueMilliseconds === undefined
      ? undefined
      : issueQueue({
          directory: settings.directory,
          runtimeDirectory: settings.runtimeDirectory,
          intervalMilliseconds: settings.queueMilliseconds,
        });
  return {
    socket: service.socket,
    close: async () => {
      await queue?.stop();
      await Promise.all([worker.close(), github.close()]);
      await service.close();
    },
  };
}
