import {
  lineDrafts,
  type TranscriptDraft,
  type TranscriptKind,
} from "./transcript-lines.ts";
import {
  maskedText,
  shownText,
  summaryLine,
  withoutControls,
} from "./transcript-text.ts";

export type { TranscriptKind } from "./transcript-lines.ts";

export interface TranscriptEntry {
  readonly position: number;
  readonly attempt: number;
  readonly kind: TranscriptKind;
  readonly text: string;
  readonly tool: string | null;
  readonly callId: string | null;
  readonly summary: string;
  readonly error: boolean;
  readonly omittedBytes: number;
}

export interface TranscriptAttempt {
  readonly attempt: number;
  readonly resumed: boolean;
}

export interface TranscriptPrompt {
  readonly attempt: number;
  readonly prompt: string;
}

export interface TranscriptFiles {
  readonly text: string;
  readonly size: number;
  readonly attempts: readonly TranscriptAttempt[];
  readonly prompts: readonly TranscriptPrompt[];
}

export interface ParsedTranscript {
  readonly bytes: number;
  readonly attempt: number;
  readonly entries: readonly TranscriptEntry[];
}

export interface TranscriptSource extends Pick<
  TranscriptFiles,
  "text" | "attempts" | "prompts"
> {
  readonly open: boolean;
  readonly privateTexts: readonly string[];
}

export interface TranscriptPage {
  readonly entries: readonly TranscriptEntry[];
  readonly nextAfter: number;
}

export const transcriptLimits = { entries: 200, bytes: 262_144 } as const;

export const emptyTranscript: ParsedTranscript = {
  bytes: 0,
  attempt: 1,
  entries: [],
};

const encoder = new TextEncoder();

function completeLines(
  source: Pick<TranscriptSource, "text" | "open">,
): readonly string[] {
  const lines = source.text.split("\n");
  const last = lines.pop() ?? "";
  return source.open || last === "" ? lines : [...lines, last];
}

function consumedText(source: Pick<TranscriptSource, "text" | "open">): string {
  return source.open
    ? source.text.slice(0, source.text.lastIndexOf("\n") + 1)
    : source.text;
}

function attemptDraft(
  attempt: number,
  attempts: readonly TranscriptAttempt[],
): TranscriptDraft {
  const resumed = attempts.some(
    (item) => item.attempt === attempt && item.resumed,
  );
  const line = `Attempt ${String(attempt)}`;
  return {
    kind: "notice",
    text: resumed ? `${line} (resumed after a restart)` : line,
  };
}

function promptDrafts(
  attempt: number,
  prompts: readonly TranscriptPrompt[],
): TranscriptDraft[] {
  const found = prompts.find((item) => item.attempt === attempt);
  const prompt = found?.prompt ?? "";
  return prompt.trim() === "" ? [] : [{ kind: "prompt", text: prompt }];
}

function shownTool(
  draft: TranscriptDraft,
  privateTexts: readonly string[],
): Pick<TranscriptEntry, "tool" | "summary"> {
  if (draft.tool === undefined) return { tool: null, summary: "" };
  const tool = maskedText(withoutControls(draft.tool), privateTexts);
  const input = maskedText(withoutControls(draft.summary ?? ""), privateTexts);
  return {
    tool,
    summary: maskedText(`${tool}: ${summaryLine(input)}`, privateTexts),
  };
}

function shownCall(
  draft: TranscriptDraft,
  privateTexts: readonly string[],
): string | null {
  if (draft.callId === undefined || draft.callId === "") return null;
  return maskedText(withoutControls(draft.callId), privateTexts);
}

function entryOf(
  draft: TranscriptDraft,
  place: {
    readonly position: number;
    readonly attempt: number;
    readonly privateTexts: readonly string[];
  },
): TranscriptEntry {
  const { text, omittedBytes } = shownText(draft.text, place.privateTexts);
  const { tool, summary } = shownTool(draft, place.privateTexts);
  return {
    position: place.position,
    attempt: place.attempt,
    kind: draft.kind,
    text,
    tool,
    callId: shownCall(draft, place.privateTexts),
    summary,
    error: draft.error ?? false,
    omittedBytes,
  };
}

export function transcriptAppended(
  parsed: ParsedTranscript,
  source: TranscriptSource,
): ParsedTranscript {
  const entries = [...parsed.entries];
  let { attempt } = parsed;
  const added = (drafts: readonly TranscriptDraft[]): void => {
    for (const draft of drafts)
      entries.push(
        entryOf(draft, {
          position: entries.length + 1,
          attempt,
          privateTexts: source.privateTexts,
        }),
      );
  };
  if (entries.length === 0) added(promptDrafts(attempt, source.prompts));
  for (const line of completeLines(source)) {
    const boundary = line.trim() === "";
    if (boundary) attempt += 1;
    added(
      boundary
        ? [
            attemptDraft(attempt, source.attempts),
            ...promptDrafts(attempt, source.prompts),
          ]
        : lineDrafts(line),
    );
  }
  const bytes = parsed.bytes + encoder.encode(consumedText(source)).length;
  return { bytes, attempt, entries };
}

export function transcriptEntries(source: TranscriptSource): TranscriptEntry[] {
  return [...transcriptAppended(emptyTranscript, source).entries];
}

export function transcriptPage(
  entries: readonly TranscriptEntry[],
  query: { readonly after: number },
): TranscriptPage {
  const page: TranscriptEntry[] = [];
  let bytes = 0;
  for (const entry of entries.slice(query.after)) {
    const size = encoder.encode(JSON.stringify(entry)).length;
    if (page.length === transcriptLimits.entries) break;
    if (page.length > 0 && bytes + size > transcriptLimits.bytes) break;
    page.push(entry);
    bytes += size;
  }
  return { entries: page, nextAfter: page.at(-1)?.position ?? query.after };
}
