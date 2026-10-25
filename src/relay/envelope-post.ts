import type { JsonObject } from "solid-objects";
import { record } from "../protocol.ts";
import type { PostedEnvelope, PostOutcome } from "./phone-delivery.ts";
import { relayRequest } from "./relay-http.ts";
import { readLink } from "./relay-registration.ts";

export interface PostContext {
  readonly phoneDirectory: string;
  readonly now: () => number;
}

const textFields = [
  "envelopeId",
  "kind",
  "ciphertext",
  "expiresAt",
  "push",
] as const;

function postedEnvelope(value: unknown): PostedEnvelope | undefined {
  const fields = record(value);
  if (fields === undefined) return undefined;
  if (!textFields.every((name) => typeof fields[name] === "string"))
    return undefined;
  const collapseId: unknown = fields["collapseId"] ?? null;
  if (collapseId !== null && typeof collapseId !== "string") return undefined;
  return {
    envelopeId: String(fields["envelopeId"]),
    kind: String(fields["kind"]),
    ciphertext: String(fields["ciphertext"]),
    expiresAt: String(fields["expiresAt"]),
    push: String(fields["push"]),
    collapseId,
  };
}

function postedEnvelopes(
  value: unknown,
): readonly PostedEnvelope[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.flatMap((item: unknown) => {
    const envelope = postedEnvelope(item);
    return envelope === undefined ? [] : [envelope];
  });
  return parsed.length === value.length ? parsed : undefined;
}

function body(
  deviceId: string,
  envelopes: readonly PostedEnvelope[],
): Readonly<Record<string, unknown>> {
  return {
    envelopes: envelopes.map((envelope) => ({
      device_id: deviceId,
      envelope_id: envelope.envelopeId,
      kind: envelope.kind,
      ciphertext: envelope.ciphertext,
      expires_at: envelope.expiresAt,
      push: envelope.push,
      collapse_id: envelope.collapseId,
    })),
  };
}

export async function postEnvelopes(
  context: PostContext,
  request: JsonObject,
): Promise<PostOutcome> {
  const at = context.now();
  const deviceId = request["deviceId"];
  const envelopes = postedEnvelopes(request["envelopes"]);
  if (typeof deviceId !== "string" || envelopes === undefined)
    return { at, failure: "relay-request-invalid" };
  const link = await readLink(context.phoneDirectory).catch(() => undefined);
  if (link === undefined) return { at, failure: "relay-unregistered" };
  const reply = await relayRequest(link.origin, {
    method: "POST",
    path: "/api/v1/relay/envelopes",
    token: link.token,
    body: body(deviceId, envelopes),
  }).catch(() => undefined);
  if (reply === undefined) return { at, failure: "relay-unreachable" };
  if (reply.status !== 201)
    return { at, failure: `relay-status-${String(reply.status)}` };
  return { at, failure: null };
}
