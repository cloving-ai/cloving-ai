import { record, type Fields } from "../protocol.ts";
import { closeDecisions } from "./decision-close.ts";
import {
  fullEnvelope,
  previewEnvelope,
  promptDigest,
} from "./decision-envelopes.ts";
import type { PostedEnvelope } from "./phone-delivery.ts";
import type { PhoneDevice } from "./phone-devices.ts";
import { storedRegistration, type Registration } from "./relay-registration.ts";
import {
  envelopeExpiry,
  resultOf,
  rows,
  sealedPost,
  type CheckContext,
} from "./sealed-post.ts";

export type { CheckContext } from "./sealed-post.ts";

interface Plan {
  readonly decision: Fields;
  readonly workflowId: string;
  readonly registration: Registration;
}

async function devicePosts(
  context: CheckContext,
  plan: Plan & { readonly device: PhoneDevice },
): Promise<readonly PostedEnvelope[]> {
  const { decision, workflowId } = plan;
  const issued = context.now();
  const posts = [];
  for (const build of [previewEnvelope, fullEnvelope])
    posts.push(
      await sealedPost(context, {
        registration: plan.registration,
        device: plan.device,
        decisionId: String(decision["decisionId"]),
        issuedAt: new Date(issued).toISOString(),
        expiresAt: envelopeExpiry(decision["expiresAt"], issued),
        build: (target) => build({ decision, workflowId, target }),
      }),
    );
  return posts;
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
  plan: Plan & { readonly devices: readonly PhoneDevice[] },
): Promise<void> {
  const decisionId = String(plan.decision["decisionId"]);
  const delivered = new Set(
    (await context.store.delivery.list(decisionId))
      .filter((item) => item.topic === "decision")
      .map((item) => item.deviceId),
  );
  for (const device of plan.devices.filter(
    (item) => !delivered.has(item.deviceId),
  ))
    await context.store.delivery.offer(decisionId, {
      runId: String(plan.decision["runId"]),
      promptDigest: promptDigest(String(plan.decision["prompt"])),
      deviceId: device.deviceId,
      envelopes: await devicePosts(context, { ...plan, device }),
    });
}

export async function checkDecisions(context: CheckContext): Promise<void> {
  const registration = await storedRegistration(context.phoneDirectory);
  if (registration === undefined) return;
  const questions = await resultOf(context, {
    operation: "questions",
    parameters: {},
  });
  if (questions === undefined) return;
  const decisions = rows(questions["decisions"]);
  const devices = (await context.store.devices()).filter(
    (device) => device.state === "connected" && device.removedAt === null,
  );
  const known = new Map<string, string>();
  for (const decision of devices.length === 0 ? [] : decisions) {
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
  await closeDecisions(context, {
    registration,
    pending: new Set(decisions.map((decision) => decision["decisionId"])),
  });
  await context.store.delivery.sweep();
}
