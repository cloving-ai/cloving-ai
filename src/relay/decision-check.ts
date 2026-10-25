import { randomBytes } from "node:crypto";
import {
  record,
  type Fields,
  type Reply,
  type ServiceRequest,
} from "../protocol.ts";
import {
  fullEnvelope,
  previewEnvelope,
  type DecisionSource,
} from "./decision-envelopes.ts";
import { sealEnvelope } from "./envelope.ts";
import type { PhoneDevice } from "./phone-devices.ts";
import { storedRegistration, type Registration } from "./relay-registration.ts";
import type { DeliveryOffer, RelayStore } from "./relay-store.ts";

export interface CheckContext {
  readonly phoneDirectory: string;
  readonly store: RelayStore;
  readonly control: (request: ServiceRequest) => Promise<Reply>;
  readonly now: () => number;
}

interface Plan {
  readonly decision: Fields;
  readonly workflowId: string;
  readonly device: PhoneDevice;
  readonly registration: Registration;
}

const envelopeLifetimeMilliseconds = 7 * 86_400_000 - 3_600_000;

function rows(value: unknown): readonly Fields[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    const fields = record(item);
    return fields === undefined ? [] : [fields];
  });
}

async function resultOf(
  context: CheckContext,
  request: ServiceRequest,
): Promise<Fields | undefined> {
  const reply = await context.control(request);
  return reply.kind === "result" ? reply.result : undefined;
}

function envelopeExpiry(decision: Fields, issued: number): string {
  const limit = issued + envelopeLifetimeMilliseconds;
  const gate = Date.parse(String(decision["expiresAt"]));
  return new Date(
    Number.isNaN(gate) ? limit : Math.min(gate, limit),
  ).toISOString();
}

async function sealedOffer(
  context: CheckContext,
  plan: Plan,
): Promise<DeliveryOffer> {
  const { decision, workflowId, device, registration } = plan;
  const issued = context.now();
  const expiresAt = envelopeExpiry(decision, issued);
  const envelopes = [];
  for (const build of [previewEnvelope, fullEnvelope]) {
    const source: DecisionSource = {
      decision,
      workflowId,
      target: {
        daemonId: registration.link.daemonId,
        deviceId: device.deviceId,
        sequence: await context.store.nextSequence(device.deviceId),
        issuedAt: new Date(issued).toISOString(),
        expiresAt,
      },
    };
    const envelope = build(source);
    const sealed = sealEnvelope(registration.keys, {
      envelope,
      agreementPublicKey: device.agreementPublicKey,
    });
    envelopes.push({
      envelopeId: randomBytes(16).toString("base64url"),
      kind: envelope.kind,
      ciphertext: sealed.toString("base64url"),
      expiresAt,
    });
  }
  return { deviceId: device.deviceId, envelopes };
}

async function workflowOf(
  context: CheckContext,
  lookup: { readonly runId: string; readonly known: Map<string, string> },
): Promise<string | undefined> {
  const known = lookup.known.get(lookup.runId);
  if (known !== undefined) return known;
  const status = await resultOf(context, {
    operation: "status",
    parameters: { runId: lookup.runId },
  });
  const workflowId = record(status?.["run"])?.["workflowId"];
  if (typeof workflowId !== "string") return undefined;
  lookup.known.set(lookup.runId, workflowId);
  return workflowId;
}

async function offerDecision(
  context: CheckContext,
  plan: Omit<Plan, "device"> & { readonly devices: readonly PhoneDevice[] },
): Promise<void> {
  const decisionId = String(plan.decision["decisionId"]);
  const delivered = new Set(
    (await context.store.delivery.list(decisionId)).map(
      (item) => item.deviceId,
    ),
  );
  for (const device of plan.devices.filter(
    (item) => !delivered.has(item.deviceId),
  ))
    await context.store.delivery.offer(
      decisionId,
      await sealedOffer(context, { ...plan, device }),
    );
}

export async function checkDecisions(context: CheckContext): Promise<void> {
  const registration = await storedRegistration(context.phoneDirectory);
  if (registration === undefined) return;
  const devices = (await context.store.devices()).filter(
    (device) => device.state === "connected" && device.removedAt === null,
  );
  if (devices.length === 0) return;
  const questions = await resultOf(context, {
    operation: "questions",
    parameters: {},
  });
  const known = new Map<string, string>();
  for (const decision of rows(questions?.["decisions"])) {
    const runId = String(decision["runId"]);
    const workflowId = await workflowOf(context, { runId, known });
    if (workflowId !== undefined)
      await offerDecision(context, {
        decision,
        workflowId,
        registration,
        devices,
      });
  }
}
