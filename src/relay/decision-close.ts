import { record } from "../protocol.ts";
import { closedEnvelope } from "./decision-envelopes.ts";
import type { DeviceEnvelopes } from "./phone-delivery.ts";
import type { OpenDecision } from "./phone-outbox.ts";
import type { Registration } from "./relay-registration.ts";
import {
  envelopeExpiry,
  resultOf,
  rows,
  sealedPost,
  type CheckContext,
} from "./sealed-post.ts";

interface Ending {
  readonly decisionId: string;
  readonly outcome: string;
  readonly actor: string | null;
}

const outcomes: ReadonlySet<unknown> = new Set([
  "answered",
  "approved",
  "denied",
  "expired",
]);

async function endingOf(
  context: CheckContext,
  open: OpenDecision,
): Promise<Ending> {
  const status = await resultOf(context, {
    operation: "status",
    parameters: { runId: open.runId },
  });
  const decided = rows(record(status?.["run"])?.["decisions"]).find(
    (item) => item["decisionId"] === open.decisionId,
  );
  const outcome = decided?.["decision"];
  const actor = decided?.["actor"];
  return {
    decisionId: open.decisionId,
    outcome:
      typeof outcome === "string" && outcomes.has(outcome)
        ? outcome
        : "unknown",
    actor: typeof actor === "string" ? actor : null,
  };
}

async function closeDecision(
  context: CheckContext,
  scope: { readonly registration: Registration; readonly open: OpenDecision },
): Promise<void> {
  const { decisionId } = scope.open;
  const reached = new Set(
    (await context.store.delivery.list(decisionId))
      .filter(
        (item) =>
          item.topic === "decision" &&
          (item.state === "sent" || item.state === "pending"),
      )
      .map((item) => item.deviceId),
  );
  const devices = (await context.store.devices()).filter(
    (device) =>
      reached.has(device.deviceId) &&
      device.state === "connected" &&
      device.removedAt === null,
  );
  const ending = await endingOf(context, scope.open);
  const issued = context.now();
  const closing: DeviceEnvelopes[] = [];
  for (const device of devices) {
    const post = await sealedPost(context, {
      registration: scope.registration,
      device,
      decisionId,
      issuedAt: new Date(issued).toISOString(),
      expiresAt: envelopeExpiry(null, issued),
      build: (target) => closedEnvelope({ ending, target }),
    });
    closing.push({ deviceId: device.deviceId, envelopes: [post] });
  }
  await context.store.delivery.close(decisionId, {
    devices: closing,
    at: issued,
  });
}

export async function closeDecisions(
  context: CheckContext,
  scope: {
    readonly registration: Registration;
    readonly pending: ReadonlySet<unknown>;
  },
): Promise<void> {
  for (const open of await context.store.delivery.open())
    if (!scope.pending.has(open.decisionId))
      await closeDecision(context, {
        registration: scope.registration,
        open,
      });
}
