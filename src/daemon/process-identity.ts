import { execFile } from "node:child_process";
import { userInfo } from "node:os";

export interface ProcessIdentity {
  readonly start: string;
  readonly command: string;
}

export interface RecordedProcess {
  readonly processId: number;
  readonly processStart: string;
  readonly marker: string;
}

export function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export function processIdentity(
  processId: number,
): Promise<ProcessIdentity | undefined> {
  return new Promise((settle) => {
    execFile(
      "ps",
      ["-ww", "-o", "lstart=", "-o", "command=", "-p", String(processId)],
      { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const parts = stdout.trim().split(/\s+/);
        if (error !== null || parts.length < 6) {
          settle(undefined);
          return;
        }
        settle({
          start: parts.slice(0, 5).join(" "),
          command: parts.slice(5).join(" "),
        });
      },
    );
  });
}

export type ProcessMatch = "same" | "other" | "unknown";

export async function processMatch(
  recorded: RecordedProcess,
): Promise<ProcessMatch> {
  const identity = await processIdentity(recorded.processId);
  if (identity === undefined)
    return processExists(recorded.processId) ? "unknown" : "other";
  return identity.start === recorded.processStart &&
    identity.command.split(" ").includes(recorded.marker)
    ? "same"
    : "other";
}

export interface FoundProcess {
  readonly processId: number;
  readonly processStart: string;
  readonly startedAt: number;
}

export interface ProcessSearch {
  readonly marker: string;
  readonly since: number;
}

const shownStartLagMilliseconds = 1000;

const elapsedPattern = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/;

function elapsedMilliseconds(text: string): number {
  const match = elapsedPattern.exec(text);
  if (match === null) return Number.NaN;
  const seconds = [match[2], match[3], match[4]].reduce(
    (total, part) => total * 60 + Number(part ?? 0),
    0,
  );
  return (Number(match[1] ?? 0) * 86_400 + seconds) * 1000;
}

function markedLine(
  line: string,
  search: ProcessSearch & { readonly now: number },
): readonly FoundProcess[] {
  const parts = line.trim().split(/\s+/);
  const processId = Number(parts[0]);
  const processStart = parts.slice(1, 6).join(" ");
  if (
    !Number.isSafeInteger(processId) ||
    !parts.slice(7).includes(search.marker)
  )
    return [];
  const startedAt = search.now - elapsedMilliseconds(String(parts[6]));
  return startedAt >= search.since - shownStartLagMilliseconds
    ? [{ processId, processStart, startedAt }]
    : [];
}

export function markedProcesses(
  search: ProcessSearch,
): Promise<readonly FoundProcess[] | undefined> {
  return new Promise((settle) => {
    execFile(
      "ps",
      [
        "-ww",
        "-U",
        String(userInfo().uid),
        "-o",
        "pid=",
        "-o",
        "lstart=",
        "-o",
        "etime=",
        "-o",
        "command=",
      ],
      { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        const now = Date.now();
        settle(
          error === null
            ? stdout
                .split("\n")
                .flatMap((line) => markedLine(line, { ...search, now }))
            : undefined,
        );
      },
    );
  });
}
