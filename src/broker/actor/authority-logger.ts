import type { Logger } from "solid-objects";

type Entry = Readonly<Record<string, unknown>>;

function line(level: string, entry: Entry): string {
  try {
    return `${JSON.stringify({ level, ...entry })}\n`;
  } catch {
    return `${JSON.stringify({ level, event: "unserializable-log-entry" })}\n`;
  }
}

export function lineLogger(write: (text: string) => void): Logger {
  const level =
    (name: string) =>
    (entry: Entry): void => {
      write(line(name, entry));
    };
  return {
    debug: level("debug"),
    info: level("info"),
    warn: level("warn"),
    error: level("error"),
  };
}
