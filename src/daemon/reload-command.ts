import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface ReloadCommandOutput {
  readonly stdout: string;
  readonly failure: string;
}

const executed = promisify(execFile);

function errorText(error: Error, name: string): string {
  const value: unknown = Reflect.get(error, name);
  const shown = typeof value === "string" || typeof value === "number";
  return shown ? String(value) : "";
}

function failedOutput(error: unknown): ReloadCommandOutput {
  if (!(error instanceof Error)) return { stdout: "", failure: "" };
  const signal = errorText(error, "signal");
  const ended =
    signal === ""
      ? `exited with code ${errorText(error, "code")}`
      : `stopped on signal ${signal}`;
  const end = errorText(error, "stderr").trim().slice(-2048);
  const failure = ` It ${ended}${end === "" ? "." : `: ${end}`}`;
  return { stdout: errorText(error, "stdout"), failure };
}

export async function reloadCommandOutput(
  command: readonly string[],
): Promise<ReloadCommandOutput> {
  const [executable = "", ...fixed] = command;
  return await executed(executable, fixed, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).then((result) => ({ stdout: result.stdout, failure: "" }), failedOutput);
}
