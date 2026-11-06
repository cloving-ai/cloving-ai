import {
  adapters,
  daemonIdentity,
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
import type { queueConnection } from "./queue-control.ts";
import type { scheduleConnection } from "./schedule-control.ts";
import type { QueueLimitsSource } from "./queue-limits.ts";
import { daemonLoops } from "./daemon-loops.ts";
import { clearedTreeClaims } from "./tree-claims.ts";
import { treeSweep } from "./tree-sweep.ts";
import { authorityRuns, recordRetention } from "./record-sweep.ts";
import {
  bundleSweep,
  unfinishedPins,
  type CurrentBundle,
} from "./bundle-sweep.ts";
import { retentionExpiry, turnDetailsPlace } from "./turn-details.ts";
import { defaultRetention } from "../record-retention.ts";
import type { ThreadPoolWatch } from "../cli/thread-pool.ts";
import { controlConnections, controlPorts } from "./daemon-controls.ts";
import {
  daemonRegistrations,
  queueWorkflowId,
  workflowReload,
} from "./workflow-reload.ts";

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
      timing: { ...bridgeTiming, runWaitChecks: settings.runWaitChecks },
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

function retentionReads(settings: DaemonSettings, ports: Promise<HostPorts>) {
  const place = {
    directory: settings.directory,
    retention: settings.retention ?? defaultRetention,
    runs: async (runIds: readonly string[]) =>
      authorityRuns(await ports)(runIds),
    now: settings.retentionClock ?? Date.now,
  };
  return {
    turnDetails: turnDetailsPlace(place),
    retentionExpired: retentionExpiry(place),
  };
}

function rejectedOpening(detail: string): DaemonOpening {
  return {
    kind: "refused",
    reason: detail.startsWith("queue-workflow-conflict")
      ? "queue-workflow-conflict"
      : "workflow-rejected",
    detail,
  };
}

function workflowOptions(
  settings: DaemonSettings,
  parts: {
    readonly generations: ReturnType<typeof workflowGenerations>;
    readonly turnSettings: Adapters["turnSettings"];
    readonly queueLimitSource: QueueLimitsSource;
    readonly current: CurrentBundle;
  },
) {
  const { reloadCommand, loadBundle } = settings;
  const { generations, turnSettings, queueLimitSource, current } = parts;
  return {
    workflowBundles: {
      directory: join(settings.directory, "workflow-bundles"),
      repository: settings.repository,
    },
    workflowRefusals: settings.workflowRefusals ?? [],
    retainedWorkflow: generations.available,
    ...(settings.bundleDigest === undefined
      ? {}
      : { bundleDigest: settings.bundleDigest }),
    ...(reloadCommand === undefined || loadBundle === undefined
      ? {}
      : {
          reload: current.reloading(
            workflowReload({
              ...settings,
              reloadCommand,
              loadBundle,
              generations,
              turnSettings,
              queueLimitSource,
            }),
          ),
        }),
  };
}

async function openDaemon(settings: DaemonSettings): Promise<DaemonOpening> {
  const { table, admitted } = await daemonRegistrations(settings);
  if (admitted.kind === "rejected") return rejectedOpening(admitted.detail);
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
  const controls = controlConnections(settings);
  const opening = await startService({
    ...daemonIdentity(settings),
    ...controlPorts(controls),
    ...(settings.queueDailySpendLimitUsd === undefined
      ? {}
      : { queueDailySpendLimitUsd: settings.queueDailySpendLimitUsd }),
    workerHarness: worker.harness,
    ...retentionReads(settings, given.promise),
    commandEffects: commandEffects(join(settings.directory, "commands")),
    stateDirectory: join(settings.directory, "state"),
    runtimeDirectory: settings.runtimeDirectory,
    ...workflowOptions(settings, { ...resources, ...controls, generations }),
    workflows: admitted.registrations,
    delivery: deliveryRouter({
      runs,
      effects: { claude: worker, github, handoff, command: commands },
    }),
    effects: { leaseMilliseconds: turnLeaseMilliseconds },
    host: async (ports) => {
      await clearedTreeClaims(settings.directory);
      given.resolve(ports);
      return hosted(settings, { ports, generations });
    },
  });
  if (opening.kind === "refused") {
    await closeWorkers({ ...resources, pool: controls.pool });
    return opening;
  }
  const running = { ...resources, ...controls, service: opening.service };
  await recoverWorkers(running, given.promise);
  return {
    kind: "started",
    daemon: await runningDaemon(settings, { ...running, ports: given.promise }),
  };
}

type Workers = Pick<Adapters, "worker" | "github" | "commands"> & {
  readonly pool: ThreadPoolWatch;
};

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
  resources.pool.stop();
  await Promise.all([
    resources.worker.close(),
    resources.github.close(),
    resources.commands.close(),
  ]);
}

async function retentionLoop(
  settings: DaemonSettings,
  resources: {
    readonly current: CurrentBundle;
    readonly ports: Promise<HostPorts>;
  },
) {
  const ports = await resources.ports;
  const sweep = {
    directory: settings.directory,
    retention: settings.retention ?? defaultRetention,
    now: settings.retentionClock ?? Date.now,
    log: (line: string) => process.stderr.write(line),
  };
  return recordRetention({
    ...sweep,
    runs: authorityRuns(ports),
    trees: treeSweep({
      ...sweep,
      runs: authorityRuns(ports),
      repository: settings.repository,
      gh: settings.githubCommand ?? ["gh"],
    }),
    bundles: bundleSweep({
      ...sweep,
      current: resources.current,
      pinned: unfinishedPins({
        state: ports.state,
        manifest: ports.workflow.manifest,
      }),
    }),
  });
}

async function runningDaemon(
  settings: DaemonSettings,
  resources: {
    readonly service: Service;
    readonly schedules: ReturnType<typeof scheduleConnection>;
    readonly queues: ReturnType<typeof queueConnection>;
    readonly queueLimitSource: QueueLimitsSource;
    readonly current: CurrentBundle;
    readonly ports: Promise<HostPorts>;
  } & Workers,
): Promise<Daemon> {
  const { service, github } = resources;
  const retention = await retentionLoop(settings, resources);
  await github.scan();
  const loops = await daemonLoops({
    ...settings,
    scheduleConnection: resources.schedules,
    queueConnection: resources.queues,
    queueLimits: resources.queueLimitSource.current,
    submit: service.worker.submit,
    queueWorkflowId: queueWorkflowId(settings),
  }).catch(async (error: unknown) => {
    await retention.stop();
    await closeWorkers(resources);
    await service.close();
    throw error;
  });
  return {
    socket: service.socket,
    close: async () => {
      await retention.stop();
      await loops.stop();
      await closeWorkers(resources);
      await service.close();
    },
  };
}
