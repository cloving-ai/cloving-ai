import { codexStream } from "./codex-stream.ts";
import { cursorStream } from "./cursor-stream.ts";
import { geminiStream } from "./gemini-stream.ts";
import { opencodeStream } from "./opencode-stream.ts";
import { grokUsageWarnings } from "../grok-result.ts";
import { usageOf } from "../worker-usage.ts";
import type { StreamResult } from "./claude-stream.ts";
import {
  receivedLines,
  receivedText,
  streamEnd,
  streamState,
  type StreamInput,
} from "./turn-stream.ts";

interface HarnessAdapter {
  readonly line: (line: string) => readonly string[];
  readonly error?: (chunk: string) => void;
  readonly result: (exitCode: number | null) => string;
}

function harnessAdapter(
  worker: string | undefined,
): HarnessAdapter | undefined {
  if (worker === "opencode") {
    const translated = opencodeStream();
    return { ...translated, error: translated.stderr };
  }
  if (worker === "codex") return codexStream();
  if (worker === "cursor-agent") return cursorStream();
  if (worker === "gemini") return geminiStream();
  return undefined;
}

export function translatedHarness(worker: string | undefined): boolean {
  return harnessAdapter(worker) !== undefined;
}

export interface ReaderStart extends StreamInput {
  readonly command: readonly string[];
}

export interface HarnessReader {
  readonly text: (chunk: string) => void;
  readonly error: ((chunk: string) => void) | undefined;
  readonly finish: (ending: {
    readonly exitCode: number | null;
    readonly refused: boolean;
  }) => void;
  readonly result: () => Promise<StreamResult | undefined>;
}

function errorReader(
  adapter: HarnessAdapter | undefined,
  warnings: ReturnType<typeof grokUsageWarnings> | undefined,
): ((chunk: string) => void) | undefined {
  if (warnings !== undefined) return warnings.write;
  return adapter?.error;
}

export function harnessReader(
  start: ReaderStart,
  transcript: (text: string) => void,
): HarnessReader {
  const stream = streamState();
  const adapter = harnessAdapter(start.worker);
  const warnings = start.worker === "grok" ? grokUsageWarnings() : undefined;
  const emitted = (lines: readonly string[]): void => {
    transcript(lines.map((line) => `${line}\n`).join(""));
    receivedLines(stream, { ...start, lines });
  };
  return {
    text: (chunk) => {
      if (adapter === undefined) {
        transcript(chunk);
        receivedText(stream, { ...start, text: chunk });
        return;
      }
      const lines = `${stream.pending}${chunk}`.split("\n");
      stream.pending = lines.pop() ?? "";
      emitted(lines.flatMap(adapter.line));
    },
    error: errorReader(adapter, warnings),
    finish: ({ exitCode, refused }) => {
      const pending = stream.pending;
      stream.pending = "";
      if (adapter === undefined) {
        receivedLines(stream, { ...start, lines: [pending] });
        return;
      }
      emitted(adapter.line(pending));
      emitted(refused ? [] : [adapter.result(exitCode)]);
    },
    result: async () => {
      const result = await streamEnd(stream, start.command);
      return result !== undefined && warnings?.incomplete() === true
        ? { ...result, usage: usageOf(null), costUsd: null }
        : result;
    },
  };
}
