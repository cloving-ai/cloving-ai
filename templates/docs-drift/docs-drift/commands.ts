import { runCommand } from "cloving/workflows/steps/run-command";
import {
  completedText,
  failure,
  jsonValue,
  list,
  record,
  text,
} from "./fields.ts";

export interface DriftInput {
  readonly cycleId: string;
  readonly input: { readonly text?: string };
}

export interface Candidate {
  readonly doc: string;
  readonly since: string | null;
  readonly code: readonly string[];
  readonly codeCount: number;
}

export interface Scan {
  readonly commit: string;
  readonly candidates: readonly Candidate[];
  readonly more: number;
}

const bad = "invalid-docs-candidates";
const commitId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
export const docPath = /^(?!.*\.\.)(?!\/)[\w./-]+\.md$/;

function count(value: unknown, minimum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    failure(bad);
  return value;
}

function candidateOf(value: unknown): Candidate {
  const item = record(value, bad);
  const since = item["since"];
  const code = list(item["code"], { reason: bad, maximum: 50 }).map((path) =>
    text(path, { reason: bad, pattern: /^\S/, maximum: 300 }),
  );
  if (code.length === 0) failure(bad);
  return {
    doc: text(item["doc"], { reason: bad, pattern: docPath, maximum: 300 }),
    since:
      since === null
        ? null
        : text(since, { reason: bad, pattern: commitId, maximum: 64 }),
    code,
    codeCount: count(item["codeCount"], code.length),
  };
}

export async function docsCandidates(): Promise<Scan> {
  const input: Readonly<Record<string, never>> = {};
  const output = record(
    jsonValue(
      completedText(
        await runCommand({
          scope: { phase: "scan", operation: "docs-candidates", round: 1 },
          name: "docs-candidates",
          input: input,
        }),
        bad,
      ),
      bad,
    ),
    bad,
  );
  const candidates = list(output["candidates"], {
    reason: bad,
    maximum: 15,
  }).map((value) => candidateOf(value));
  const docs = candidates.map((item) => item.doc);
  if (new Set(docs).size !== docs.length) failure(bad);
  return {
    commit: text(output["commit"], {
      reason: bad,
      pattern: commitId,
      maximum: 64,
    }),
    candidates,
    more: count(output["more"], 0),
  };
}

export async function recordAudit(request: {
  readonly commit: string;
  readonly docs: readonly string[];
}): Promise<void> {
  completedText(
    await runCommand({
      scope: { phase: "record", operation: "docs-drift-record", round: 1 },
      name: "docs-drift-record",
      input: { commit: request.commit, docs: request.docs },
    }),
    "missing-record-result",
  );
}
