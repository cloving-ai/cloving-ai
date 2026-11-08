import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  authorityTiming,
  openAuthority,
  type Authority,
  type AuthorityTiming,
  type Delivery,
  type EffectSettings,
  type Refusal,
} from "../broker/actor/authority.ts";
import { socketAddress } from "../broker/socket-address.ts";
import { type WorkflowRefusal } from "../workflow-refusals.ts";
import { changeSignal } from "./changes.ts";
import { expiryScan } from "./expiry.ts";
import { commandGateway, workerCommandBound, type Gateway } from "./gateway.ts";
import {
  workflowCatalog,
  type Registry,
  type WorkflowCatalog,
  type WorkflowRegistration,
  type WorkflowBundleStore,
} from "./registry.ts";
import { reloadOperation, type WorkflowReloadPort } from "./workflow-reload.ts";
import {
  errorMessage,
  queryMetadata,
  type ServiceContext,
  type ServiceReads,
} from "./replies.ts";
import { dispatcher } from "./dispatcher.ts";
import type { ServiceIdentity } from "./service-identity.ts";
import { connectionLimits, listen, reachable } from "./transport.ts";
import { workerPort, type WorkerPort } from "./worker-port.ts";
import { runWaitTarget } from "./run-waits.ts";
import { runNotes, type RunNote } from "./run-notes.ts";
import type { RunWaitTarget } from "../run-wait.ts";
import type { CommandEffects } from "../command-settings.ts";
import { commandWaitPort, type CommandWaitPort } from "./command-waits.ts";

export type { WorkflowRegistration } from "./registry.ts";
export type {
  EffectReply,
  EffectReport,
  EffectRequest,
  WorkerPort,
} from "./worker-port.ts";

export interface ServiceTiming {
  readonly authority: AuthorityTiming;
  readonly expiryScanMilliseconds: number;
  readonly livenessMilliseconds: number;
  readonly followMilliseconds: number;
  readonly resolverMilliseconds: number;
  readonly idleMilliseconds: number;
}

export const serviceTiming: ServiceTiming = {
  authority: authorityTiming,
  expiryScanMilliseconds: 1_000,
  livenessMilliseconds: 600_000,
  followMilliseconds: 250,
  resolverMilliseconds: 30_000,
  idleMilliseconds: connectionLimits.idleMilliseconds,
};

export interface ServiceLimits {
  readonly textBytes: number;
  readonly documentBytes: number;
  readonly pendingWorkerCommands: number;
}

export const serviceLimits: ServiceLimits = {
  textBytes: 65_536,
  documentBytes: 262_144,
  pendingWorkerCommands: workerCommandBound,
};

export interface ServiceHost {
  readonly close: () => Promise<void>;
  readonly reports?: () => readonly unknown[];
}

export interface HostPorts {
  readonly commandWait: CommandWaitPort;
  readonly runWait?: {
    readonly target: (runId: string) => Promise<RunWaitTarget | undefined>;
    readonly observe: WorkerPort["observe"];
  };
  readonly state: Authority["state"];
  readonly submit: WorkerPort["submit"];
  readonly input: (runId: string) => Promise<string | undefined>;
  readonly document: (digest: string) => Promise<string | undefined>;
  readonly workflow: {
    readonly id: (runId: string) => Promise<string | undefined>;
    readonly manifest: Authority["queries"]["manifest"];
    readonly available: (
      runId: string,
      workflowId?: string,
    ) => Promise<boolean>;
  };
  readonly requestEffect: WorkerPort["requestEffect"];
  readonly operation: Authority["effects"]["operation"];
  readonly operations: Authority["effects"]["operations"];
  readonly reportEffect: WorkerPort["reportEffect"];
  readonly openGate: WorkerPort["openGate"];
  readonly registerWait: WorkerPort["registerWait"];
  readonly notes: {
    readonly read: (runId: string) => Promise<readonly RunNote[]>;
  };
}

export interface ServiceOptions extends ServiceReads, ServiceIdentity {
  readonly schedule?: NonNullable<ServiceContext["schedule"]>;
  readonly queue?: NonNullable<ServiceContext["queue"]>;
  readonly queueDailySpendLimitUsd?: number;
  readonly spendScope?: "queue" | "all";
  readonly commandEffects?: CommandEffects;
  readonly stateDirectory: string;
  readonly runtimeDirectory: string;
  readonly workflows: readonly WorkflowRegistration[];
  readonly retainedWorkflows?: readonly WorkflowRegistration[];
  readonly workflowBundles?: WorkflowBundleStore;
  readonly retainedWorkflow?: Registry["available"];
  readonly workflowRefusals?: readonly WorkflowRefusal[];
  readonly bundleDigest?: string;
  readonly reload?: WorkflowReloadPort;
  readonly delivery: Delivery;
  readonly host?: (ports: HostPorts) => Promise<ServiceHost>;
  readonly timing?: ServiceTiming;
  readonly limits?: ServiceLimits;
  readonly effects?: Partial<EffectSettings>;
  readonly clock?: () => string;
}

export interface Service {
  readonly socket: string;
  readonly epoch: number;
  readonly worker: WorkerPort;
  readonly close: () => Promise<void>;
}

export type ServiceOpening =
  { readonly kind: "started"; readonly service: Service } | Refusal;

function refused(reason: string, detail: string): Refusal {
  return { kind: "refused", reason, detail };
}

async function privateDirectory(
  directory: string,
): Promise<Refusal | undefined> {
  const entry = await lstat(directory).catch(() => undefined);
  if (entry === undefined || !entry.isDirectory())
    return refused("insecure-runtime-directory", "not a directory");
  const owned = entry.uid === process.getuid?.();
  const mode = entry.mode & 0o777;
  if (owned && (mode & 0o077) === 0) return undefined;
  return refused(
    "insecure-runtime-directory",
    owned ? `mode ${mode.toString(8)}` : "owned by a different user",
  );
}

async function endpoint(directory: string): Promise<string | Refusal> {
  const insecure = await privateDirectory(directory);
  if (insecure !== undefined) return insecure;
  const address = socketAddress(join(directory, "control.sock"));
  if (address.kind === "refused") return address;
  if (await reachable(address.path))
    return refused("service-already-running", directory);
  return address.path;
}

function wallClock(): string {
  return new Date().toISOString();
}

function catalogContext(options: ServiceOptions, catalog: WorkflowCatalog) {
  return {
    registry: catalog.registry,
    workflowCatalog: catalog,
    ...(options.reload === undefined
      ? {}
      : { reload: reloadOperation({ port: options.reload, catalog }) }),
  };
}

async function started(
  authority: Authority,
  setup: {
    readonly options: ServiceOptions;
    readonly path: string;
    readonly timing: ServiceTiming;
    readonly catalog: WorkflowCatalog;
    readonly gateway: Gateway;
    readonly worker: WorkerPort;
    readonly host: ServiceHost | undefined;
  },
): Promise<Service> {
  const { options, path, timing, catalog, gateway, host } = setup;
  const clock = options.clock ?? wallClock;
  const { textBytes, documentBytes } = options.limits ?? serviceLimits;
  await rm(path, { force: true });
  const changes = changeSignal(authority.changes.subscribe);
  const listener = await listen({
    path,
    limits: { idleMilliseconds: timing.idleMilliseconds },
    handle: dispatcher({
      authority,
      ...catalogContext(options, catalog),
      ...queryMetadata(options),
      gateway,
      clock,
      changed: changes.next,
      livenessMilliseconds: timing.livenessMilliseconds,
      followMilliseconds: timing.followMilliseconds,
      resolverMilliseconds: timing.resolverMilliseconds,
      textBytes,
      documentBytes,
      worldReports: () => host?.reports?.() ?? [],
    }),
  });
  const stopping = new AbortController();
  const delivering = Promise.allSettled([authority.deliver(stopping.signal)]);
  const expiry = expiryScan({
    authority,
    gateway,
    clock,
    intervalMilliseconds: timing.expiryScanMilliseconds,
  });
  return {
    socket: path,
    epoch: authority.epoch,
    worker: setup.worker,
    close: async () => {
      changes.close();
      await expiry.stop();
      await listener.close();
      stopping.abort();
      await delivering;
      await released(authority, host);
    },
  };
}

async function released(
  authority: Authority,
  host: ServiceHost | undefined,
): Promise<void> {
  try {
    await host?.close();
  } finally {
    await authority.close();
  }
}

export async function startService(
  options: ServiceOptions,
): Promise<ServiceOpening> {
  const path = await endpoint(options.runtimeDirectory);
  if (typeof path !== "string") return path;
  const timing = options.timing ?? serviceTiming;
  const catalog = workflowCatalog(options);
  const { registry } = catalog;
  const opening = await openAuthority(options.stateDirectory, {
    delivery: options.delivery,
    timing: timing.authority,
    available: registry.available,
    ...(options.effects === undefined ? {} : { effects: options.effects }),
    ...(options.effectLeases === undefined
      ? {}
      : { leaseLimits: options.effectLeases.current }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  if (opening.kind === "refused") return opening;
  const { authority } = opening;
  const gateway = serviceGateway(authority, { options, registry });
  const worker = workerPort({ gateway, authority });
  const host = await hosted(
    options,
    hostPorts(authority, { worker, registry, gateway }),
  );
  if (host.kind === "refused") {
    await authority.close();
    return host;
  }
  try {
    return {
      kind: "started",
      service: await started(authority, {
        options,
        path,
        timing,
        catalog,
        gateway,
        worker,
        host: host.host,
      }),
    };
  } catch (error) {
    const unclosed = await released(authority, host.host).then(
      () => "",
      (failure: unknown) => `; the close failed: ${errorMessage(failure)}`,
    );
    return refused("transport-failure", `${errorMessage(error)}${unclosed}`);
  }
}

function serviceGateway(
  authority: Authority,
  parts: { readonly options: ServiceOptions; readonly registry: Registry },
): Gateway {
  const limits = parts.options.limits ?? serviceLimits;
  return commandGateway({
    authority,
    registry: parts.registry,
    clock: parts.options.clock ?? wallClock,
    textBytes: limits.textBytes,
    pendingWorkerCommands: limits.pendingWorkerCommands,
  });
}

function hostPorts(
  authority: Authority,
  parts: {
    readonly worker: WorkerPort;
    readonly registry: Registry;
    readonly gateway: Gateway;
  },
): HostPorts {
  const { worker, registry } = parts;
  return {
    commandWait: commandWaitPort({ authority, gateway: parts.gateway }),
    runWait: {
      target: (runId) => runWaitTarget(authority, runId),
      observe: worker.observe,
    },
    state: authority.state,
    submit: worker.submit,
    input: async (runId) => {
      const digest = (await authority.state()).details[runId]?.input;
      return typeof digest === "string"
        ? await authority.queries.document(digest)
        : undefined;
    },
    document: authority.queries.document,
    requestEffect: worker.requestEffect,
    reportEffect: worker.reportEffect,
    openGate: worker.openGate,
    registerWait: worker.registerWait,
    operation: authority.effects.operation,
    operations: authority.effects.operations,
    notes: { read: (runId) => runNotes({ authority }, runId) },
    workflow: {
      id: async (runId) => (await authority.queries.workflowIds())[runId],
      manifest: authority.queries.manifest,
      available: async (runId, workflowId) => {
        const manifest = await authority.queries.manifest(runId);
        return (
          manifest !== undefined &&
          (workflowId === undefined || manifest.workflowId === workflowId) &&
          (await registry.available(manifest)) !== undefined
        );
      },
    },
  };
}

async function hosted(
  options: ServiceOptions,
  ports: HostPorts,
): Promise<
  { readonly kind: "started"; readonly host: ServiceHost | undefined } | Refusal
> {
  try {
    return { kind: "started", host: await options.host?.(ports) };
  } catch (error) {
    return refused("host-unavailable", errorMessage(error));
  }
}
