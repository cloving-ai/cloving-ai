import { component } from "../src/cli/watch-element.ts";
import { Transcript } from "../src/cli/watch-transcript-view.ts";
import type { TranscriptEntry } from "../src/turn-transcript.ts";
import { rendered } from "./watch-dom.ts";
import { entry } from "./turn-transcript-fixture.ts";
import { sampleTurn } from "./watch-sample.ts";

export const worktree = "clv-333";
export const tree = `/work/trees/${worktree}`;

export function terminal(...entries: readonly TranscriptEntry[]): string {
  const turn = sampleTurn({ worktree, outcome: "in work" });
  return rendered(
    component(Transcript, {
      run: { runId: "run-1", turns: [turn] },
      turn,
      turnId: null,
      now: turn.startedAt,
      controls: {
        tab: "transcript",
        onTab: () => undefined,
        view: () => ({
          shown: true,
          expanded: false,
          entries,
          state: "open",
          message: "",
          earlier: false,
          unseen: 0,
          detached: false,
        }),
        onToggle: () => undefined,
        onExpand: () => undefined,
        onLink: () => undefined,
        onScroll: () => undefined,
        onJump: () => undefined,
        onEarlier: () => undefined,
        onRetry: () => undefined,
      },
    }),
  );
}

export function numbered(from: number, to: number): string {
  return Array.from(
    { length: to - from + 1 },
    (_, index) => `line ${String(from + index)}`,
  ).join("\n");
}

export function call(
  position: number,
  fields: {
    readonly tool: string;
    readonly input: unknown;
    readonly callId?: string;
  },
): TranscriptEntry {
  return entry(position, {
    kind: "tool-call",
    tool: fields.tool,
    callId: fields.callId ?? `call-${String(position)}`,
    summary: `${fields.tool}: x`,
    text: JSON.stringify(fields.input, null, 2),
  });
}

export function result(
  position: number,
  fields: {
    readonly callId: string;
    readonly text: string;
    readonly error?: true;
  },
): TranscriptEntry {
  return entry(position, {
    kind: "tool-result",
    callId: fields.callId,
    text: fields.text,
    error: fields.error === true,
  });
}

export function visible(html: string): string[] {
  return html
    .replaceAll(/<\/summary>[\s\S]*?<\/details>/g, "</summary>")
    .replaceAll(/<\/(div|summary|pre|p)>/g, "\n")
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .split("\n")
    .filter((line) => line.trim() !== "");
}
