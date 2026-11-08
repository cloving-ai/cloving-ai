import {
  lineDrafts,
  type TranscriptDraft,
  type TranscriptKind,
} from "./transcript-lines.ts";
import { maskedText, shownText, withoutControls } from "./transcript-text.ts";

export type { TranscriptKind } from "./transcript-lines.ts";

export interface TranscriptEntry {
  readonly position: number;
  readonly attempt: number;
  readonly kind: TranscriptKind;
  readonly text: string;
  readonly tool: string | null;
  readonly summary: string;
  readonly error: boolean;
  readonly omittedBytes: number;
}

export interface TranscriptAttempt {
  readonly attempt: number;
  readonly resumed: boolean;
}

export interface TranscriptFiles {
  readonly text: string;
  readonly attempts: readonly TranscriptAttempt[];
}

export interface TranscriptSource extends TranscriptFiles {
  readonly open: boolean;
  readonly privateTexts: readonly string[];
}

export interface TranscriptPage {
  readonly entries: readonly TranscriptEntry[];
  readonly nextAfter: number;
}

export const transcriptLimits = { entries: 200, bytes: 262_144 } as const;

const encoder = new TextEncoder();

function completeLines(text: string, open: boolean): readonly string[] {
  const lines = text.split("\n");
  const last = lines.pop() ?? "";
  return open || last === "" ? lines : [...lines, last];
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

function entryOf(
  draft: TranscriptDraft,
  place: {
    readonly position: number;
    readonly attempt: number;
    readonly privateTexts: readonly string[];
  },
): TranscriptEntry {
  const { text, omittedBytes } = shownText(draft.text, place.privateTexts);
  return {
    position: place.position,
    attempt: place.attempt,
    kind: draft.kind,
    text,
    tool: draft.tool ?? null,
    summary: maskedText(
      withoutControls(draft.summary ?? ""),
      place.privateTexts,
    ),
    error: draft.error ?? false,
    omittedBytes,
  };
}

export function transcriptEntries(source: TranscriptSource): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let attempt = 1;
  for (const line of completeLines(source.text, source.open)) {
    const boundary = line.trim() === "";
    if (boundary) attempt += 1;
    const drafts = boundary
      ? [attemptDraft(attempt, source.attempts)]
      : lineDrafts(line);
    for (const draft of drafts)
      entries.push(
        entryOf(draft, {
          position: entries.length + 1,
          attempt,
          privateTexts: source.privateTexts,
        }),
      );
  }
  return entries;
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
