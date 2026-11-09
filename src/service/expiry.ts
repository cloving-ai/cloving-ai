import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { notBefore } from "../authority/instants.ts";
import type { Authority, StoredState } from "../broker/actor/authority.ts";
import { operationDigest } from "../broker/operation-digest.ts";
import type { Gateway } from "./gateway.ts";
import { expireCommandWaits } from "./command-waits.ts";

export interface ExpiryScan {
  readonly stop: () => Promise<void>;
}

interface ScanParts {
  readonly authority: Authority;
  readonly gateway: Gateway;
  readonly clock: () => string;
  readonly intervalMilliseconds: number;
}

interface LeaseEnd {
  readonly sequence: number;
  readonly endsAt: string | null;
}

interface Pass {
  readonly lease: LeaseEnd;
  readonly pauseMilliseconds: number;
}

interface GateEnd {
  readonly runId: string;
  readonly gateId: string;
  readonly expiresAt: string;
}

function expiryIdentity(runId: string, gateId: string): string {
  return `expire:${createHash("sha256").update(`${runId} ${gateId}`).digest("hex").slice(0, 32)}`;
}

function gateEnds(state: StoredState): readonly GateEnd[] {
  return Object.values(state.gates).flatMap((gate) =>
    gate.outcome === null &&
    gate.expiresAt !== null &&
    state.runs[gate.runId]?.status === "waiting_gate"
      ? [{ runId: gate.runId, gateId: gate.gateId, expiresAt: gate.expiresAt }]
      : [],
  );
}

async function leaseEnd(
  authority: Authority,
  current: {
    readonly state: StoredState;
    readonly known: LeaseEnd | undefined;
  },
): Promise<LeaseEnd> {
  const { state, known } = current;
  if (known?.sequence === state.sequence) return known;
  return {
    sequence: state.sequence,
    endsAt: await authority.effects.leases.nextEnd(),
  };
}

async function expireGates(
  gateway: Gateway,
  gates: readonly GateEnd[],
): Promise<void> {
  for (const gate of gates)
    await gateway.execute({
      principal: "controller",
      command: {
        kind: "expire-gate",
        commandId: expiryIdentity(gate.runId, gate.gateId),
        runId: gate.runId,
        gateId: gate.gateId,
      },
    });
}

async function expireLeases(parts: ScanParts, now: string): Promise<void> {
  for (const lease of await parts.authority.effects.leases.due(now))
    await parts.gateway.execute({
      principal: "controller",
      command: {
        kind: "expire-lease",
        commandId: `expire-lease:${operationDigest(lease.operationId)}:${String(lease.generation)}`,
        runId: lease.runId,
        operationId: lease.operationId,
        leaseGeneration: lease.generation,
      },
    });
}

function deadlines(state: StoredState, lease: LeaseEnd): readonly number[] {
  return [
    ...gateEnds(state).map((gate) => Date.parse(gate.expiresAt)),
    ...Object.values(state.commandWaits ?? {}).flatMap((wait) =>
      wait.state === "waiting" ? [wait.deadline] : [],
    ),
    ...(lease.endsAt === null ? [] : [Date.parse(lease.endsAt)]),
  ];
}

function pauseMilliseconds(
  parts: ScanParts,
  pass: {
    readonly state: StoredState;
    readonly lease: LeaseEnd;
    readonly now: string;
  },
): number {
  const now = Date.parse(pass.now);
  const ahead = deadlines(pass.state, pass.lease).filter(
    (deadline) => deadline > now,
  );
  return Math.min(
    parts.intervalMilliseconds,
    ...ahead.map((deadline) => deadline - now),
  );
}

async function scanned(parts: ScanParts, known?: LeaseEnd): Promise<Pass> {
  const { authority, gateway, clock } = parts;
  const state = await authority.state();
  const lease = await leaseEnd(authority, { state, known });
  const now = clock();
  await expireCommandWaits({ waits: state.commandWaits ?? {}, gateway, now });
  await expireGates(
    gateway,
    gateEnds(state).filter((gate) => notBefore(now, gate.expiresAt)),
  );
  if (lease.endsAt !== null && notBefore(now, lease.endsAt))
    await expireLeases(parts, now);
  return {
    lease,
    pauseMilliseconds: pauseMilliseconds(parts, { state, lease, now }),
  };
}

async function cycle(parts: ScanParts, signal: AbortSignal): Promise<void> {
  let known: LeaseEnd | undefined;
  while (!signal.aborted) {
    const pass = await scanned(parts, known).catch(() => undefined);
    known = pass?.lease ?? known;
    await delay(
      pass?.pauseMilliseconds ?? parts.intervalMilliseconds,
      undefined,
      { signal },
    ).catch(() => undefined);
  }
}

export function expiryScan(parts: ScanParts): ExpiryScan {
  const stopping = new AbortController();
  const running = cycle(parts, stopping.signal);
  return {
    stop: async () => {
      stopping.abort();
      await running;
    },
  };
}
