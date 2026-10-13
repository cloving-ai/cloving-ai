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
import type { Reply, ServiceRequest } from "../protocol.ts";
import { decision, questions } from "./decision-handler.ts";
import { events, type Connection } from "./event-handler.ts";
import { expiryScan } from "./expiry.ts";
import { commandGateway, workerCommandBound, type Gateway } from "./gateway.ts";
import {
  workflowRegistry,
  type Registry,
  type WorkflowRegistration,
} from "./registry.ts";
import { failed, type ServiceContext } from "./replies.ts";
import { runCommand, status } from "./run-handlers.ts";
import { submissionHandler } from "./submission-handler.ts";
import { connectionLimits, listen, reachable } from "./transport.ts";
import { workerPort, type WorkerPort } from "./worker-port.ts";

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
  readonly state: Authority["state"];
  readonly submit: WorkerPort["submit"];
  readonly input: (runId: string) => Promise<string | undefined>;
  readonly document: (digest: string) => Promise<string | undefined>;
  readonly workflowId: (runId: string) => Promise<string | undefined>;
  readonly requestEffect: WorkerPort["requestEffect"];
  readonly operation: Authority["effects"]["operation"];
}

export interface ServiceOptions {
  readonly stateDirectory: string;
  readonly runtimeDirectory: string;
  readonly workflows: readonly WorkflowRegistration[];
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

function dispatcher(
  context: ServiceContext,
): (
  request: ServiceRequest,
  connection: Connection,
) => Promise<Reply | undefined> {
  const run = submissionHandler(context);
  const operations = new Map<
    string,
    (
      request: ServiceRequest,
      connection: Connection,
    ) => Promise<Reply | undefined>
  >([
    ["run", (request) => run(request.parameters)],
    ["status", (request) => status(context, request.parameters)],
    ["questions", (request) => questions(context, request.parameters)],
    ["decision", (request) => decision(context, request.parameters)],
    ["run-command", (request) => runCommand(context, request.parameters)],
    [
      "events",
      (request, connection) =>
        events(context, { parameters: request.parameters, connection }),
    ],
  ]);
  return (request, connection) => {
    const operation = operations.get(request.operation);
    if (operation === undefined)
      return Promise.resolve(
        failed("unknown-operation", {
          detail: `The service has no operation ${request.operation}.`,
        }),
      );
    return operation(request, connection);
  };
}

async function started(
  authority: Authority,
  setup: {
    readonly options: ServiceOptions;
    readonly path: string;
    readonly timing: ServiceTiming;
    readonly registry: Registry;
    readonly gateway: Gateway;
    readonly worker: WorkerPort;
    readonly host: ServiceHost | undefined;
  },
): Promise<Service> {
  const { options, path, timing, registry, gateway, host } = setup;
  const clock = options.clock ?? wallClock;
  const { textBytes, documentBytes } = options.limits ?? serviceLimits;
  await rm(path, { force: true });
  const listener = await listen({
    path,
    limits: { idleMilliseconds: timing.idleMilliseconds },
    handle: dispatcher({
      authority,
      registry,
      gateway,
      clock,
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
  const registry = workflowRegistry(options.workflows);
  const opening = await openAuthority(options.stateDirectory, {
    delivery: options.delivery,
    timing: timing.authority,
    available: registry.available,
    ...(options.effects === undefined ? {} : { effects: options.effects }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  if (opening.kind === "refused") return opening;
  const { authority } = opening;
  const gateway = serviceGateway(authority, { options, registry });
  const worker = workerPort({ gateway, authority });
  const host = await hosted(options, hostPorts(authority, worker));
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
        registry,
        gateway,
        worker,
        host: host.host,
      }),
    };
  } catch (error) {
    const unclosed = await released(authority, host.host).then(
      () => "",
      (failure: unknown) => `; the close failed: ${message(failure)}`,
    );
    return refused("transport-failure", `${message(error)}${unclosed}`);
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

function hostPorts(authority: Authority, worker: WorkerPort): HostPorts {
  return {
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
    operation: authority.effects.operation,
    workflowId: async (runId) => (await authority.queries.workflowIds())[runId],
  };
}

function message(error: unknown): string {
  return String(Reflect.get(Object(error), "message"));
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
    return refused("host-unavailable", message(error));
  }
}
