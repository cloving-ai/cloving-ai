import { createHash } from "node:crypto";
import { operationalDecision } from "../decision-visibility.ts";
import type { Fields } from "../protocol.ts";
import {
  plaintextBytes,
  type Envelope,
  type EnvelopeKind,
} from "./envelope.ts";

export interface EnvelopeTarget {
  readonly daemonId: string;
  readonly deviceId: string;
  readonly sequence: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface DecisionSource {
  readonly decision: Fields;
  readonly workflowId: string;
  readonly target: EnvelopeTarget;
}

const previewBytes = 2048;
const fullBytes = 65_535;

export function promptDigest(prompt: string): string {
  return `sha256:${createHash("sha256").update(prompt).digest("hex")}`;
}

function prefix(text: string, bytes: number): string {
  let used = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (used + size > bytes) break;
    used += size;
    end += character.length;
  }
  return text.slice(0, end);
}

function fitted(
  prompt: string,
  sizing: {
    readonly limit: number;
    readonly build: (shown: string) => Envelope;
  },
): Envelope {
  let shown = prompt;
  let envelope = sizing.build(shown);
  while (plaintextBytes(envelope) > sizing.limit && shown !== "") {
    const excess = plaintextBytes(envelope) - sizing.limit;
    shown = prefix(shown, Buffer.byteLength(shown) - excess);
    envelope = sizing.build(shown);
  }
  return envelope;
}

function envelopeOf(
  source: DecisionSource,
  content: { readonly kind: EnvelopeKind; readonly body: Fields },
): Envelope {
  return { version: 1, ...source.target, ...content };
}

export function receiptEnvelope(source: {
  readonly receipt: Fields;
  readonly target: EnvelopeTarget;
}): Envelope {
  return {
    version: 1,
    ...source.target,
    kind: "receipt",
    body: source.receipt,
  };
}

export function closedEnvelope(source: {
  readonly ending: {
    readonly decisionId: string;
    readonly outcome: string;
    readonly actor: string | null;
  };
  readonly target: EnvelopeTarget;
}): Envelope {
  return {
    version: 1,
    ...source.target,
    kind: "closed",
    body: source.ending,
  };
}

export function previewEnvelope(source: DecisionSource): Envelope {
  const { decision, workflowId } = source;
  const prompt = String(operationalDecision(decision, workflowId)["prompt"]);
  return fitted(prompt, {
    limit: previewBytes,
    build: (shown) =>
      envelopeOf(source, {
        kind: "preview",
        body: {
          decisionId: decision["decisionId"],
          label: decision["label"] ?? null,
          type: decision["type"],
          workflowId,
          expiresAt: decision["expiresAt"] ?? null,
          prompt: shown,
          truncated: shown.length < prompt.length,
        },
      }),
  });
}

export function fullEnvelope(source: DecisionSource): Envelope {
  const { decision, workflowId } = source;
  const prompt = String(decision["prompt"]);
  return fitted(prompt, {
    limit: fullBytes,
    build: (shown) =>
      envelopeOf(source, {
        kind: "full",
        body: {
          decisionId: decision["decisionId"],
          label: decision["label"] ?? null,
          type: decision["type"],
          runId: decision["runId"],
          workflowId,
          prompt: shown,
          allowed: decision["allowed"],
          revision: decision["revision"],
          generation: decision["generation"],
          subjectDigest: decision["subjectDigest"],
          promptDigest: promptDigest(prompt),
          expiresAt: decision["expiresAt"] ?? null,
          truncated: shown.length < prompt.length,
        },
      }),
  });
}
