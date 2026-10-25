import type { JsonObject } from "solid-objects";
import type { PostOutcome } from "./phone-delivery.ts";
import { relayRequest } from "./relay-http.ts";
import { readLink } from "./relay-registration.ts";

export interface PostContext {
  readonly phoneDirectory: string;
  readonly now: () => number;
}

function field(item: unknown, name: string): unknown {
  return Reflect.get(Object(item), name);
}

function body(
  deviceId: string,
  envelopes: readonly unknown[],
): Readonly<Record<string, unknown>> {
  return {
    envelopes: envelopes.map((envelope) => ({
      device_id: deviceId,
      envelope_id: field(envelope, "envelopeId"),
      kind: field(envelope, "kind"),
      ciphertext: field(envelope, "ciphertext"),
      expires_at: field(envelope, "expiresAt"),
      push: field(envelope, "kind") === "preview" ? "alert" : "none",
    })),
  };
}

export async function postEnvelopes(
  context: PostContext,
  request: JsonObject,
): Promise<PostOutcome> {
  const at = context.now();
  const { deviceId, envelopes } = request;
  if (typeof deviceId !== "string" || !Array.isArray(envelopes))
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
