import { execFile } from "node:child_process";

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

export async function sameProcess(recorded: RecordedProcess): Promise<boolean> {
  const identity = await processIdentity(recorded.processId);
  return (
    identity !== undefined &&
    identity.start === recorded.processStart &&
    identity.command.split(" ").includes(recorded.marker)
  );
}
