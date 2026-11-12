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
import { spendSettings } from "../service/replies.ts";
import {
  workflowGenerations,
  prepareWorkflowGenerations,
} from "./workflow-generations.ts";
import { deliveryRouter } from "./delivery-router.ts";
import { commandEffects } from "./command-journal.ts";
import { worldDirectory } from "./host-environment.ts";
import { pinnedWorkflowHandler } from "./workflow-replay.ts";
import { scheduledDeclarations } from "./workflow-schedules.ts";
import { queueConnection } from "./queue-control.ts";
import { scheduleConnection } from "./schedule-control.ts";
import { queueLimitsSource, type QueueLimitsSource } from "./queue-limits.ts";
import { effectLeaseLimits } from "../queue-room.ts";
import { restartMarks } from "./restart-marks.ts";
import type { RestartPort } from "../restart-request.ts";
import { daemonLoops } from "./daemon-loops.ts";
import { clearedTreeClaims } from "./tree-claims.ts";
import { authorityRuns } from "./record-sweep.ts";
import { currentBundle, type CurrentBundle } from "./bundle-sweep.ts";
import {
  noteReceiptsPlace,
  retentionExpiry,
  turnDetailsPlace,
} from "./turn-details.ts";
import { transcriptFiles } from "./transcript-files.ts";
import { githubReader } from "./github-read.ts";
import { defaultRetention } from "../record-retention.ts";
import { threadPoolWatch, type ThreadPoolWatch } from "../cli/thread-pool.ts";
import { stalledLine } from "../thread-pool-check.ts";
import { retentionLoop } from "./daemon-retention.ts";
import type { CloseOptions } from "./claude-worker.ts";
import {
  daemonRegistrations,
  queueWorkflowIds,
  workflowReload,
} from "./workflow-reload.ts";

export interface Daemon {
  readonly socket: string;
  readonly close: (options?: CloseOptions) => Promise<void>;
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

function controlConnections(settings: DaemonSettings): {
  readonly schedules: ReturnType<typeof scheduleConnection>;
  readonly queues: ReturnType<typeof queueConnection>;
  readonly current: CurrentBundle;
  readonly pool: ThreadPoolWatch;
  readonly restart: RestartPort;
  readonly queueLimitSource: QueueLimitsSource;
} {
  return {
    restart: {
      ...restartMarks(settings.directory),
      ...(settings.validateRestart === undefined
        ? {}
        : { validate: settings.validateRestart }),
    },
    queueLimitSource: queueLimitsSource(settings),
    schedules: scheduleConnection(),
    queues: queueConnection(),
    pool: threadPoolWatch({
      ...settings.threadPool,
      stalled: (check) => {
        process.stderr.write(stalledLine(check));
      },
    }),
    current: currentBundle({
      directory: settings.directory,
      bundleDigest: settings.bundleDigest,
      now: settings.retentionClock ?? Date.now,
      log: (line) => process.stderr.write(line),
    }),
  };
}

function controlPorts(controls: ReturnType<typeof controlConnections>) {
  return {
    schedule: controls.schedules.request,
    queue: controls.queues.port,
    queues: controls.queues.ports,
    threadPool: controls.pool.latest,
    restart: controls.restart,
    effectLeases: {
      current: () => effectLeaseLimits(controls.queueLimitSource.current()),
    },
  };
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
    turnTranscript: {
      read: transcriptFiles(settings.directory),
      privateTexts: settings.privateTexts ?? [],
      cache: new Map(),
    },
    retentionExpired: retentionExpiry(place),
    noteReceipts: noteReceiptsPlace(place),
    githubRead: githubReader(settings),
  };
}

function rejectedOpening(detail: string): DaemonOpening {
  return {
    kind: "refused",
    reason: "workflow-rejected",
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
    ...spendSettings(settings),
    workerHarness: worker.harness,
    turnRecovery: resources.recoveries,
    turnSteering: { steer: worker.steer },
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
  resources.recoveries.finish();
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

async function closeWorkers(
  resources: Workers,
  options: CloseOptions = {},
): Promise<void> {
  resources.pool.stop();
  await Promise.all([
    resources.worker.close(options),
    resources.github.close(),
    resources.commands.close(options),
  ]);
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
    limits: resources.queueLimitSource.current,
    submit: service.worker.submit,
    queueWorkflowIds: queueWorkflowIds(settings),
  }).catch(async (error: unknown) => {
    await retention.stop();
    await closeWorkers(resources);
    await service.close();
    throw error;
  });
  return {
    socket: service.socket,
    close: async (options = {}) => {
      await retention.stop();
      await loops.stop();
      await closeWorkers(resources, options);
      await service.close();
    },
  };
}
