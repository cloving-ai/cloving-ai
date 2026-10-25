import { createHash, verify } from "node:crypto";
import { record, type Fields } from "../protocol.ts";
import { publicKeyObject } from "./pairing-checks.ts";
import type { PhoneDevice } from "./phone-devices.ts";

export interface SignedAnswerMessage {
  readonly payload: string;
  readonly signature: string;
}

export interface AnswerScope {
  readonly daemonId: string;
  readonly routedDeviceId: string;
  readonly devices: readonly PhoneDevice[];
  readonly now: number;
  readonly sentPromptDigest: string | null;
}

export type AnswerVerdict =
  | {
      readonly kind: "decision";
      readonly decisionId: string;
      readonly parameters: Fields;
    }
  | {
      readonly kind: "refused";
      readonly code: string;
      readonly decisionId: string | null;
    };

interface Answer {
  readonly daemonId: string;
  readonly deviceId: string;
  readonly decisionId: string;
  readonly command: string;
  readonly text: string | null;
  readonly textDigest: string | null;
  readonly expectedRevision: number;
  readonly generation: number;
  readonly subjectDigest: string;
  readonly promptDigest: string;
  readonly commandId: string;
  readonly signedAt: number;
  readonly keyClass: string;
}

interface Checking {
  readonly answer: Answer;
  readonly device: PhoneDevice;
  readonly message: SignedAnswerMessage;
  readonly scope: AnswerScope;
}

const textNames = [
  "daemonId",
  "deviceId",
  "decisionId",
  "command",
  "subjectDigest",
  "promptDigest",
  "commandId",
  "signedAt",
  "keyClass",
] as const;

const countNames = ["expectedRevision", "generation"] as const;

const commands: ReadonlySet<unknown> = new Set(["answer", "approve", "deny"]);

const keyClasses: ReadonlySet<unknown> = new Set(["answer", "approval"]);

const ageLimitMilliseconds = 10 * 60_000;

function payloadFields(payload: string): Fields | undefined {
  try {
    return record(JSON.parse(payload));
  } catch {
    return undefined;
  }
}

function optionalText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function wellFormed(fields: Fields): boolean {
  return (
    fields["version"] === 1 &&
    fields["kind"] === "answer" &&
    textNames.every((name) => typeof fields[name] === "string") &&
    countNames.every((name) => {
      const value = fields[name];
      return Number.isSafeInteger(value) && Number(value) >= 1;
    }) &&
    commands.has(fields["command"]) &&
    keyClasses.has(fields["keyClass"]) &&
    !Number.isNaN(Date.parse(String(fields["signedAt"])))
  );
}

function parsedAnswer(message: SignedAnswerMessage): Answer | undefined {
  const fields = payloadFields(message.payload);
  if (fields === undefined || !wellFormed(fields)) return undefined;
  const text: unknown = fields["text"] ?? null;
  const textDigest: unknown = fields["textDigest"] ?? null;
  if (!optionalText(text) || !optionalText(textDigest)) return undefined;
  const value = (name: (typeof textNames)[number]): string =>
    String(fields[name]);
  return {
    daemonId: value("daemonId"),
    deviceId: value("deviceId"),
    decisionId: value("decisionId"),
    command: value("command"),
    text,
    textDigest,
    expectedRevision: Number(fields["expectedRevision"]),
    generation: Number(fields["generation"]),
    subjectDigest: value("subjectDigest"),
    promptDigest: value("promptDigest"),
    commandId: value("commandId"),
    signedAt: Date.parse(value("signedAt")),
    keyClass: value("keyClass"),
  };
}

function deviceRefusal(device: PhoneDevice | undefined): string | undefined {
  if (device === undefined) return "device-unknown";
  if (device.removedAt !== null) return "device-revoked";
  if (device.state !== "connected") return "device-not-connected";
  return undefined;
}

function signatureValid(checking: Checking): boolean {
  const { answer, device, message } = checking;
  const key = publicKeyObject(
    answer.keyClass === "approval"
      ? device.approvalPublicKey
      : device.answerPublicKey,
  );
  if (key === undefined) return false;
  try {
    return verify(
      "sha256",
      Buffer.from(message.payload),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(message.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

const checks: readonly ((checking: Checking) => string | undefined)[] = [
  (checking) => (signatureValid(checking) ? undefined : "signature-invalid"),
  ({ answer }) =>
    answer.command !== "answer" && answer.keyClass !== "approval"
      ? "approval-key-required"
      : undefined,
  ({ answer, scope }) =>
    Math.abs(scope.now - answer.signedAt) > ageLimitMilliseconds
      ? "answer-too-old"
      : undefined,
  ({ answer, scope }) =>
    scope.sentPromptDigest === answer.promptDigest
      ? undefined
      : "prompt-changed",
  ({ answer }) => {
    const expected = answer.text === null ? null : digestOf(answer.text);
    return answer.textDigest === expected ? undefined : "answer-invalid";
  },
];

function decisionParameters(answer: Answer): Fields {
  return {
    command: answer.command,
    reference: answer.decisionId,
    ...(answer.text === null ? {} : { text: answer.text }),
    expectedRevision: answer.expectedRevision,
    generation: answer.generation,
    subjectDigest: answer.subjectDigest,
    commandId: answer.commandId,
    actor: `device:${answer.deviceId}`,
  };
}

export function answerDecisionId(message: SignedAnswerMessage): string | null {
  const decisionId = payloadFields(message.payload)?.["decisionId"];
  return typeof decisionId === "string" ? decisionId : null;
}

export function answerVerdict(
  message: SignedAnswerMessage,
  scope: AnswerScope,
): AnswerVerdict {
  const answer = parsedAnswer(message);
  if (
    answer === undefined ||
    answer.daemonId !== scope.daemonId ||
    answer.deviceId !== scope.routedDeviceId
  )
    return { kind: "refused", code: "answer-invalid", decisionId: null };
  const device = scope.devices.find(
    (item) => item.deviceId === answer.deviceId,
  );
  const refusal =
    deviceRefusal(device) ??
    (device === undefined
      ? undefined
      : checks
          .map((check) => check({ answer, device, message, scope }))
          .find((code) => code !== undefined));
  if (refusal !== undefined)
    return { kind: "refused", code: refusal, decisionId: answer.decisionId };
  return {
    kind: "decision",
    decisionId: answer.decisionId,
    parameters: decisionParameters(answer),
  };
}
