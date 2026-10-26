import { pairingIdentity, pairingLink } from "./daemon-keys.ts";
import type { PairingRequest } from "./pairing-checks.ts";
import { relayRequest } from "./relay-http.ts";
import type { Registration } from "./relay-registration.ts";

export interface OpenPairing {
  readonly pairingId: string;
  readonly secret: Buffer;
  readonly link: string;
  readonly expiresAt: string;
  readonly registration: Registration;
  readonly stop: AbortController;
  stage: "open" | "requested" | "checking";
  request: PairingRequest | undefined;
  nonce: string | undefined;
}

export class RegistrationEnded extends Error {
  constructor() {
    super("registration-ended: cloving.ai does not know this computer.");
  }
}

export interface PairingSessions {
  readonly current: () => OpenPairing | undefined;
  readonly refusal: () => string | null;
  readonly generation: () => number;
  readonly start: (
    registration: Registration,
    startedIn: number,
  ) => Promise<OpenPairing>;
  readonly end: (open: OpenPairing, refusal: string | null) => void;
  readonly cancel: () => void;
}

export interface SessionSettings {
  readonly secret: () => Buffer;
  readonly follow: (open: OpenPairing) => Promise<void>;
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

async function created(
  registration: Registration,
  secret: Buffer,
): Promise<OpenPairing> {
  const pairingId = pairingIdentity(secret);
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
  return {
    pairingId,
    secret,
    expiresAt: expiry(reply.body),
    registration,
    stop: new AbortController(),
    stage: "open",
    request: undefined,
    nonce: undefined,
    link: pairingLink(registration.link.origin, {
      secret,
      keys: registration.keys,
    }),
  };
}

function cancelled(): Error {
  return new Error("pairing-cancelled: The pairing was cancelled.");
}

export function pairingSessions(settings: SessionSettings): PairingSessions {
  let open: OpenPairing | undefined;
  let refusal: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  let generation = 0;
  const end = (ended: OpenPairing, code: string | null): void => {
    if (open !== ended) return;
    clearTimeout(timer);
    ended.stop.abort();
    open = undefined;
    refusal = code;
  };
  return {
    current: () => open,
    refusal: () => refusal,
    end,
    cancel: () => {
      generation += 1;
      if (open !== undefined) end(open, null);
    },
    generation: () => generation,
    start: async (registration, startedIn) => {
      if (startedIn !== generation) throw cancelled();
      const started = await created(registration, settings.secret());
      if (startedIn !== generation) throw cancelled();
      open = started;
      refusal = null;
      timer = setTimeout(
        () => {
          end(
            started,
            started.stage === "requested" ? "pairing-expired" : null,
          );
        },
        Date.parse(started.expiresAt) - Date.now(),
      );
      timer.unref();
      settings.follow(started).catch(() => {
        end(started, "pairing-failed");
      });
      return started;
    },
  };
}
