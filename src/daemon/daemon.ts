import {
  adapters,
  recoverCommands,
  recoverClaude,
  type Adapters,
  type DaemonSettings,
} from "./daemon-adapters.ts";
export type { DaemonSettings } from "./daemon-adapters.ts";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  registerStepBridge,
  sdkStepCall,
  stepBridge,
} from "../host/step-bridge-host.ts";
import { startHost } from "../host/world-host.ts";
import { worldLoop } from "../host/world-reconciliation.ts";
import { workflowOutcome, taggedRun, taggedRuns } from "../host/world-runs.ts";
import {
  startService,
  serviceLimits,
  type HostPorts,
  type Service,
  type ServiceHost,
} from "../service/service.ts";
import {
  workflowGenerations,
  prepareWorkflowGenerations,
} from "./workflow-generations.ts";
import { deliveryRouter } from "./delivery-router.ts";
import { commandEffects } from "./command-journal.ts";
import { worldDirectory } from "./host-environment.ts";
import { pinnedWorkflowHandler } from "./workflow-replay.ts";
import { scheduledDeclarations } from "./workflow-schedules.ts";
import { scheduleConnection } from "./schedule-control.ts";
import { daemonLoops } from "./daemon-loops.ts";
import {
  ticketRegistrations,
  ticketRegistrationTable,
} from "./ticket-registration.ts";

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
  await prepareWorkflowGenerations(ports, generations);
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

async function daemonRegistrations(settings: DaemonSettings) {
  const conflict = settings.workflowRefusals?.find((refusal) =>
    refusal.codes.includes("queue-workflow-conflict"),
  );
  if (conflict !== undefined)
    return {
      table: [],
      admitted: {
        kind: "rejected" as const,
        detail: `queue-workflow-conflict: ${conflict.scope} ${conflict.label}`,
      },
    };

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
    commands: settings.commands ?? {},
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
              registration.workflowId === queueWorkflowId(settings)
                ? { admission: settings.queueLanes ?? 1, queue: true }
                : {}),
            })),
          },
  };
}

export async function startDaemon(
  givenSettings: DaemonSettings,
): Promise<DaemonOpening> {
  const repository = await realpath(givenSettings.repository);
  const scheduled = scheduledDeclarations(givenSettings, {
    repository,
    documentBytes: serviceLimits.documentBytes,
  });
  if (scheduled.kind === "refused") return scheduled;
  return openDaemon({
    ...givenSettings,
    declarations: scheduled.declarations,
    repository,
  });
}

async function openDaemon(settings: DaemonSettings): Promise<DaemonOpening> {
  const { table, admitted } = await daemonRegistrations(settings);
  if (admitted.kind === "rejected")
    return {
      kind: "refused",
      reason: admitted.detail.startsWith("queue-workflow-conflict")
        ? "queue-workflow-conflict"
        : "workflow-rejected",
      detail: admitted.detail,
    };
  const given = Promise.withResolvers<HostPorts>();
  const generations = workflowGenerations({
    ...settings,
    registrations: admitted.registrations,
    table,
  });
  const resources = adapters(settings, { given: given.promise, generations });
  const { worker, github, runs, handoff, commands } = resources;
  await mkdir(join(settings.directory, "state"), { recursive: true });
  await mkdir(settings.runtimeDirectory, { recursive: true, mode: 0o700 });
  const schedules = scheduleConnection();
  const opening = await startService({
    schedule: schedules.request,
    ...(settings.queueDailySpendLimitUsd === undefined
      ? {}
      : { queueDailySpendLimitUsd: settings.queueDailySpendLimitUsd }),
    workerHarness: worker.harness,
    commandEffects: commandEffects(join(settings.directory, "commands")),
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
      effects: { claude: worker, github, handoff, command: commands },
    }),
    effects: { leaseMilliseconds: turnLeaseMilliseconds },
    host: (ports) => {
      given.resolve(ports);
      return hosted(settings, { ports, generations });
    },
  });
  if (opening.kind === "refused") {
    await closeWorkers(resources);
    return opening;
  }
  const running = { ...resources, service: opening.service, schedules };
  await recoverWorkers(running, given.promise);
  return {
    kind: "started",
    daemon: await runningDaemon(settings, running),
  };
}

type Workers = Pick<Adapters, "worker" | "github" | "commands">;

async function recoverWorkers(
  resources: Workers & { readonly service: Service },
  ports: Promise<HostPorts>,
): Promise<void> {
  try {
    const host = await ports;
    await recoverCommands(resources.commands, host);
    await recoverClaude(resources.worker, host);
  } catch (error) {
    await Promise.allSettled([
      closeWorkers(resources),
      resources.service.close(),
    ]);
    throw error;
  }
}

async function closeWorkers(resources: Workers): Promise<void> {
  await Promise.all([
    resources.worker.close(),
    resources.github.close(),
    resources.commands.close(),
  ]);
}

async function runningDaemon(
  settings: DaemonSettings,
  resources: {
    readonly service: Service;
    readonly schedules: ReturnType<typeof scheduleConnection>;
  } & Workers,
): Promise<Daemon> {
  const { service, github } = resources;
  await github.scan();
  const loops = await daemonLoops({
    ...settings,
    scheduleConnection: resources.schedules,
    submit: service.worker.submit,
    queueWorkflowId: queueWorkflowId(settings),
  }).catch(async (error: unknown) => {
    await closeWorkers(resources);
    await service.close();
    throw error;
  });
  return {
    socket: service.socket,
    close: async () => {
      await loops.stop();
      await closeWorkers(resources);
      await service.close();
    },
  };
}

function queueWorkflowId(settings: DaemonSettings): string | undefined {
  return settings.declarations?.find(
    (declaration) => declaration.queue === true,
  )?.workflowId;
}
