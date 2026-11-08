import {
  transcriptEntries,
  type TranscriptEntry,
} from "../src/turn-transcript.ts";

export function lines(...values: readonly unknown[]): string {
  return values
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .map((line) => `${line}\n`)
    .join("");
}

export function assistant(...content: readonly unknown[]) {
  return { type: "assistant", message: { content } };
}

export function toolResult(content: unknown, error = false) {
  return {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content,
          is_error: error,
        },
      ],
    },
  };
}

export function entry(
  position: number,
  fields: Partial<TranscriptEntry> & Pick<TranscriptEntry, "kind" | "text">,
): TranscriptEntry {
  return {
    position,
    attempt: 1,
    tool: null,
    summary: "",
    error: false,
    omittedBytes: 0,
    ...fields,
  };
}

export function read(text: string, open = false): TranscriptEntry[] {
  return transcriptEntries({ text, open, attempts: [], privateTexts: [] });
}
