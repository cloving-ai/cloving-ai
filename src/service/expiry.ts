import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { notBefore } from "../authority/instants.ts";
import type { Authority } from "../broker/actor/authority.ts";
import { operationDigest } from "../broker/operation-digest.ts";
import type { Gateway } from "./gateway.ts";
import { expireCommandWaits } from "./command-waits.ts";

export interface ExpiryScan {
  readonly stop: () => Promise<void>;
}

function expiryIdentity(runId: string, gateId: string): string {
  return `expire:${createHash("sha256").update(`${runId} ${gateId}`).digest("hex").slice(0, 32)}`;
}

async function scanned(parts: {
  readonly authority: Authority;
  readonly gateway: Gateway;
  readonly clock: () => string;
}): Promise<void> {
  const { authority, gateway, clock } = parts;
  const state = await authority.state();
  const now = clock();
  await expireCommandWaits({ waits: state.commandWaits ?? {}, gateway, now });
  const due = Object.values(state.gates).filter(
    (gate) =>
      gate.outcome === null &&
      gate.expiresAt !== null &&
      notBefore(now, gate.expiresAt) &&
      state.runs[gate.runId]?.status === "waiting_gate",
  );
  for (const gate of due)
    await gateway.execute({
      principal: "controller",
      command: {
        kind: "expire-gate",
        commandId: expiryIdentity(gate.runId, gate.gateId),
        runId: gate.runId,
        gateId: gate.gateId,
      },
    });
  for (const lease of await authority.effects.dueLeases(now))
    await gateway.execute({
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

interface ScanParts {
  readonly authority: Authority;
  readonly gateway: Gateway;
  readonly clock: () => string;
  readonly intervalMilliseconds: number;
}

async function cycle(parts: ScanParts, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await scanned(parts).catch(() => undefined);
    await delay(parts.intervalMilliseconds, undefined, { signal }).catch(
      () => undefined,
    );
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
