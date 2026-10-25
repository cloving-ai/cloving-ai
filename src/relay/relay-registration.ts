import { rm } from "node:fs/promises";
import { join } from "node:path";
import { parsePhoneLink, type PhoneLink } from "../phone/phone-link.ts";
import {
  newDaemonKeys,
  parseDaemonKeys,
  type DaemonKeys,
} from "./daemon-keys.ts";
import { readOptional, writePrivate } from "./relay-files.ts";
import { relayRequest } from "./relay-http.ts";

export interface RegistrationContext {
  readonly phoneDirectory: string;
  readonly origin: string;
  readonly computerName: string;
}

export interface Registration {
  readonly link: PhoneLink;
  readonly keys: DaemonKeys;
}

export function readLink(
  phoneDirectory: string,
): Promise<PhoneLink | undefined> {
  return readOptional(join(phoneDirectory, "link.json")).then(parsePhoneLink);
}

function readKeys(phoneDirectory: string): Promise<DaemonKeys | undefined> {
  return readOptional(join(phoneDirectory, "daemon-keys.json")).then(
    parseDaemonKeys,
  );
}

export async function forgetRegistration(
  phoneDirectory: string,
): Promise<void> {
  await rm(join(phoneDirectory, "link.json"), { force: true });
}

function text(body: unknown, name: string): string {
  const value: unknown =
    typeof body === "object" && body !== null
      ? Reflect.get(body, name)
      : undefined;
  if (typeof value !== "string" || value === "")
    throw new Error(`registration-invalid: cloving.ai sent no ${name}.`);
  return value;
}

async function registered(
  context: RegistrationContext,
  keys: DaemonKeys,
): Promise<Registration> {
  const reply = await relayRequest(context.origin, {
    method: "POST",
    path: "/api/v1/relay/daemons",
    body: {
      name: context.computerName,
      agreement_public_key: keys.agreementPublicKey,
      signing_public_key: keys.signingPublicKey,
    },
  });
  if (reply.status !== 201)
    throw new Error(
      `registration-failed: cloving.ai answered ${String(reply.status)}.`,
    );
  const link: PhoneLink = {
    daemonId: text(reply.body, "daemon_id"),
    origin: context.origin,
    token: text(reply.body, "token"),
    registeredAt: new Date().toISOString(),
  };
  await writePrivate(join(context.phoneDirectory, "link.json"), link);
  return { link, keys };
}

export async function registration(
  context: RegistrationContext,
): Promise<Registration> {
  const link = await readLink(context.phoneDirectory);
  const stored = await readKeys(context.phoneDirectory);
  if (
    link !== undefined &&
    stored !== undefined &&
    link.origin === context.origin
  )
    return { link, keys: stored };
  const keys = stored ?? newDaemonKeys();
  if (stored === undefined)
    await writePrivate(join(context.phoneDirectory, "daemon-keys.json"), keys);
  return registered(context, keys);
}
