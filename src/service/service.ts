import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  authorityTiming,
  openAuthority,
  type Authority,
  type AuthorityTiming,
  type Delivery,
  type Refusal,
} from "../broker/actor/authority.ts";
import { socketAddress } from "../broker/socket-address.ts";
import type { Reply, ServiceRequest } from "../protocol.ts";
import { decision, questions } from "./decision-handler.ts";
import { events, type Connection } from "./event-handler.ts";
import { expiryScan } from "./expiry.ts";
import { commandGateway } from "./gateway.ts";
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
export type { WorkerPort } from "./worker-port.ts";

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
}

export const serviceLimits: ServiceLimits = {
  textBytes: 65_536,
  documentBytes: 262_144,
};

export interface ServiceOptions {
  readonly stateDirectory: string;
  readonly runtimeDirectory: string;
  readonly workflows: readonly WorkflowRegistration[];
  readonly delivery: Delivery;
  readonly timing?: ServiceTiming;
  readonly limits?: ServiceLimits;
  readonly clock?: () => string;
}

export interface Service {
  readonly socket: string;
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
  },
): Promise<Service> {
  const { options, path, timing, registry } = setup;
  const clock = options.clock ?? wallClock;
  const { textBytes, documentBytes } = options.limits ?? serviceLimits;
  const gateway = commandGateway({ authority, registry, clock, textBytes });
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
    worker: workerPort(gateway),
    close: async () => {
      await expiry.stop();
      await listener.close();
      stopping.abort();
      await delivering;
      await authority.close();
    },
  };
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
  });
  if (opening.kind === "refused") return opening;
  try {
    return {
      kind: "started",
      service: await started(opening.authority, {
        options,
        path,
        timing,
        registry,
      }),
    };
  } catch (error) {
    await opening.authority.close();
    return refused(
      "transport-failure",
      String(Reflect.get(Object(error), "message")),
    );
  }
}
