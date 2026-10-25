import { pairingIdentity, pairingLink } from "./daemon-keys.ts";
import { relayRequest } from "./relay-http.ts";
import type { Registration } from "./relay-registration.ts";

export interface OpenPairing {
  readonly pairingId: string;
  readonly secret: Buffer;
  readonly link: string;
  readonly expiresAt: string;
  readonly registration: Registration;
}

export class RegistrationEnded extends Error {
  constructor() {
    super("registration-ended: cloving.ai does not know this computer.");
  }
}

export interface PairingSessions {
  readonly current: () => OpenPairing | undefined;
  readonly start: (registration: Registration) => Promise<OpenPairing>;
  readonly cancel: () => void;
}

function expiry(body: unknown): string {
  const value: unknown =
    typeof body === "object" && body !== null
      ? Reflect.get(body, "expires_at")
      : undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
    throw new Error("pairing-invalid: cloving.ai sent no expiry.");
  return value;
}

export function pairingSessions(secret: () => Buffer): PairingSessions {
  let open: OpenPairing | undefined;
  let timer: NodeJS.Timeout | undefined;
  const cancel = (): void => {
    clearTimeout(timer);
    open = undefined;
  };
  return {
    current: () => open,
    cancel,
    start: async (registration) => {
      const value = secret();
      const pairingId = pairingIdentity(value);
      const reply = await relayRequest(registration.link.origin, {
        method: "POST",
        path: "/api/v1/relay/pairings",
        token: registration.link.token,
        body: { pairing_id: pairingId },
      });
      if (reply.status === 401) throw new RegistrationEnded();
      if (reply.status !== 201)
        throw new Error(
          `pairing-failed: cloving.ai answered ${String(reply.status)}.`,
        );
      cancel();
      const expiresAt = expiry(reply.body);
      const started: OpenPairing = {
        pairingId,
        secret: value,
        expiresAt,
        registration,
        link: pairingLink(registration.link.origin, {
          secret: value,
          keys: registration.keys,
        }),
      };
      open = started;
      timer = setTimeout(
        () => {
          if (open === started) cancel();
        },
        Date.parse(expiresAt) - Date.now(),
      );
      timer.unref();
      return started;
    },
  };
}
