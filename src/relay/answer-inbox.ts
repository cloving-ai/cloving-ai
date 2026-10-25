import { setTimeout as delay } from "node:timers/promises";
import { record, type Fields, type Reply } from "../protocol.ts";
import {
  answerDecisionId,
  answerVerdict,
  type AnswerVerdict,
  type SignedAnswerMessage,
} from "./answer-check.ts";
import { receiptEnvelope } from "./decision-envelopes.ts";
import { envelopeAad, relayInfo, unpadPlaintext } from "./envelope.ts";
import { envelopesBody } from "./envelope-post.ts";
import { openFrom } from "./hpke.ts";
import type { InboxWork } from "./phone-inbox.ts";
import { relayRequest } from "./relay-http.ts";
import { storedRegistration, type Registration } from "./relay-registration.ts";
import {
  envelopeExpiry,
  sealedPost,
  type CheckContext,
} from "./sealed-post.ts";

export interface InboxReading {
  readonly waitSeconds: number;
  readonly signal: AbortSignal;
}

export interface InboxTiming {
  readonly waitSeconds: number;
  readonly retryMilliseconds: number;
}

export const inboxTiming: InboxTiming = {
  waitSeconds: 25,
  retryMilliseconds: 5000,
};

interface InboxItem {
  readonly answerId: string;
  readonly deviceId: string;
  readonly ciphertext: string;
  readonly sequence: number;
}

interface Answering {
  readonly registration: Registration;
  readonly item: InboxItem;
}

function inboxItem(value: unknown): readonly InboxItem[] {
  const fields = record(value);
  const answerId = fields?.["answer_id"];
  const deviceId = fields?.["device_id"];
  const ciphertext = fields?.["ciphertext"];
  const sequence = fields?.["sequence"];
  if (
    typeof answerId !== "string" ||
    typeof deviceId !== "string" ||
    typeof ciphertext !== "string" ||
    typeof sequence !== "number"
  )
    return [];
  return [{ answerId, deviceId, ciphertext, sequence }];
}

function inboxItems(body: unknown): readonly InboxItem[] {
  const answers = record(body)?.["answers"];
  if (!Array.isArray(answers)) return [];
  return answers
    .flatMap((item: unknown) => inboxItem(item))
    .sort((left, right) => left.sequence - right.sequence);
}

function openedAnswer(answering: Answering): SignedAnswerMessage | undefined {
  const { registration, item } = answering;
  try {
    const padded = openFrom(registration.keys.agreementPrivateKey, {
      info: relayInfo,
      aad: envelopeAad({
        daemonId: registration.link.daemonId,
        deviceId: item.deviceId,
        kind: "answer",
      }),
      sealed: Buffer.from(item.ciphertext, "base64url"),
    });
    const message = record(JSON.parse(unpadPlaintext(padded).toString("utf8")));
    const payload = message?.["payload"];
    const signature = message?.["signature"];
    if (typeof payload !== "string" || typeof signature !== "string")
      return undefined;
    return { payload, signature };
  } catch {
    return undefined;
  }
}

async function verdictOf(
  context: CheckContext,
  answering: Answering,
): Promise<AnswerVerdict> {
  const message = openedAnswer(answering);
  if (message === undefined)
    return { kind: "refused", code: "answer-invalid", decisionId: null };
  const decisionId = answerDecisionId(message);
  return answerVerdict(message, {
    daemonId: answering.registration.link.daemonId,
    routedDeviceId: answering.item.deviceId,
    devices: await context.store.devices(),
    now: context.now(),
    sentPromptDigest:
      decisionId === null
        ? null
        : await context.store.delivery.promptDigest(decisionId),
  });
}

type Answered = Reply | { readonly kind: "refused"; readonly code: string };

function receiptBody(
  base: { readonly answerId: string; readonly decisionId: string | null },
  answered: Answered,
): Fields {
  if (answered.kind === "result")
    return {
      ...base,
      code: String(answered.result["kind"]),
      outcome: answered.result["decision"] ?? null,
      receipt: answered.result["receipt"] ?? null,
    };
  const code =
    answered.kind === "refused" ? answered.code : answered.error.code;
  return { ...base, code, outcome: null, receipt: null };
}

async function receiptWork(
  context: CheckContext,
  answering: Answering,
): Promise<InboxWork> {
  const { registration, item } = answering;
  const verdict = await verdictOf(context, answering);
  const answered: Answered =
    verdict.kind === "decision"
      ? await context.control({
          operation: "decision",
          parameters: verdict.parameters,
        })
      : verdict;
  const receipt = receiptBody(
    { answerId: item.answerId, decisionId: verdict.decisionId },
    answered,
  );
  const device = (await context.store.devices()).find(
    (known) => known.deviceId === item.deviceId,
  );
  const issued = context.now();
  const envelope =
    device === undefined
      ? null
      : await sealedPost(context, {
          registration,
          device,
          decisionId: verdict.decisionId ?? item.answerId,
          issuedAt: new Date(issued).toISOString(),
          expiresAt: envelopeExpiry(null, issued),
          build: (target) => receiptEnvelope({ receipt, target }),
        });
  return {
    answerId: item.answerId,
    sequence: item.sequence,
    deviceId: item.deviceId,
    envelope,
  };
}

async function handled(
  context: CheckContext,
  answering: Answering,
): Promise<boolean> {
  const { item } = answering;
  const { link } = answering.registration;
  const work =
    (await context.store.inbox.work(item.answerId)) ??
    (await context.store.inbox.record(await receiptWork(context, answering)));
  if (work.envelope !== null) {
    const posted = await relayRequest(link.origin, {
      method: "POST",
      path: "/api/v1/relay/envelopes",
      token: link.token,
      body: envelopesBody(work.deviceId, [work.envelope]),
    });
    if (posted.status !== 201) return false;
  }
  const acknowledged = await relayRequest(link.origin, {
    method: "POST",
    path: "/api/v1/relay/inbox/acks",
    token: link.token,
    body: { answer_ids: [item.answerId] },
  });
  if (acknowledged.status !== 200) return false;
  await context.store.inbox.complete({
    answerId: item.answerId,
    sequence: item.sequence,
  });
  return true;
}

export async function readAnswers(
  context: CheckContext,
  reading: InboxReading,
): Promise<boolean> {
  const registration = await storedRegistration(context.phoneDirectory);
  if (registration === undefined) return false;
  const { link } = registration;
  const cursor = await context.store.inbox.cursor();
  const reply = await relayRequest(link.origin, {
    method: "GET",
    path: `/api/v1/relay/inbox?after=${String(cursor)}&wait=${String(reading.waitSeconds)}`,
    token: link.token,
    timeoutMilliseconds: (reading.waitSeconds + 10) * 1000,
    signal: reading.signal,
  });
  if (reply.status !== 200)
    throw new Error(
      `inbox-failed: cloving.ai answered ${String(reply.status)}.`,
    );
  for (const item of inboxItems(reply.body))
    if (!(await handled(context, { registration, item }))) return false;
  return true;
}

export async function runInbox(
  context: CheckContext,
  running: { readonly signal: AbortSignal; readonly timing: InboxTiming },
): Promise<void> {
  const { signal, timing } = running;
  while (!signal.aborted) {
    const polled = await readAnswers(context, {
      waitSeconds: timing.waitSeconds,
      signal,
    }).catch(() => false);
    if (!polled)
      await delay(timing.retryMilliseconds, undefined, { signal }).catch(
        () => undefined,
      );
  }
}
