import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  startDelivery,
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
  outcomeKind,
  taggedRun,
  taggedRuns,
} from "../host/world-runs.ts";
import {
  startService,
  type HostPorts,
  type ServiceHost,
} from "../service/service.ts";
import { claudeWorker } from "./claude-worker.ts";
import { deliveryRouter } from "./delivery-router.ts";
import { worldDirectory } from "./host-environment.ts";
import { ticketRegistration } from "./ticket-registration.ts";

export interface DaemonSettings {
  readonly directory: string;
  readonly repository: string;
  readonly manifest: string;
  readonly workflows: Readonly<Record<string, WorkflowFunction | undefined>>;
  readonly handler: WorkflowHandler;
  readonly command: readonly string[];
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
    outcome: outcomeKind,
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

export async function startDaemon(
  settings: DaemonSettings,
): Promise<DaemonOpening> {
  const { directory, repository, command } = settings;
  const admitted = await ticketRegistration(settings.manifest);
  if (admitted.kind === "rejected")
    return {
      kind: "refused",
      reason: "workflow-rejected",
      detail: admitted.detail,
    };
  const given = Promise.withResolvers<HostPorts>();
  const document = async (digest: string): Promise<string | undefined> =>
    (await given.promise).document(digest);
  const worker = claudeWorker({
    repository,
    command,
    document,
    worktrees: join(directory, "worktrees"),
    journal: join(directory, "journal"),
    report: async (report) => (await given.promise).reportEffect(report),
  });
  const runs = startDelivery({
    document,
    runs: taggedRuns,
    cancel: cancelled,
    input: async (runId) => (await given.promise).input(runId),
    workflow: async (runId) =>
      settings.workflows[String(await (await given.promise).workflowId(runId))],
  });
  await mkdir(join(directory, "state"), { recursive: true });
  await mkdir(join(directory, "runtime"), { recursive: true, mode: 0o700 });
  const opening = await startService({
    stateDirectory: join(directory, "state"),
    runtimeDirectory: join(directory, "runtime"),
    workflows: [admitted.registration],
    delivery: deliveryRouter({ runs, effects: worker }),
    effects: { leaseMilliseconds: turnLeaseMilliseconds },
    host: (ports) => {
      given.resolve(ports);
      return hosted(settings, ports);
    },
  });
  if (opening.kind === "refused") {
    await worker.close();
    return opening;
  }
  const { service } = opening;
  return {
    kind: "started",
    daemon: {
      socket: service.socket,
      close: async () => {
        await worker.close();
        await service.close();
      },
    },
  };
}
