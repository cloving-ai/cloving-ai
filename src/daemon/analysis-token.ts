import { spawn } from "node:child_process";

export type AnalysisToken =
  { readonly token: string } | { readonly error: string };

function failed(category: string): AnalysisToken {
  return { error: "analysis-token-command-" + category };
}

function commandOf(setting: string): readonly string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(setting);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const entries: readonly unknown[] = parsed;
    if (
      entries.every(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      )
    )
      return entries;
    return undefined;
  } catch {
    return undefined;
  }
}

function tokenOf(chunks: readonly Buffer[]): AnalysisToken {
  const token = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/(?:\r\n|[\r\n])$/, "");
  return /^[!-~]{1,512}$/.test(token) ? { token } : failed("output-invalid");
}

function captured(
  command: readonly string[],
  request: {
    readonly folder: string;
    readonly signal: AbortSignal | undefined;
  },
): Promise<AnalysisToken> {
  return new Promise((settle) => {
    const [program = "", ...arguments_] = command;
    const child = spawn(program, arguments_, {
      cwd: request.folder,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      signal: request.signal,
      killSignal: "SIGKILL",
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stopped = false;
    const stop = (category: string): void => {
      stopped = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      settle(failed(category));
    };
    const timer = setTimeout(() => {
      stop("timeout");
    }, 10_000);
    const received = (chunk: Buffer, output?: Buffer[]): void => {
      if (stopped) return;
      bytes += chunk.length;
      if (bytes > 4_096) {
        stop("output-too-large");
        return;
      }
      output?.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      received(chunk, chunks);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      received(chunk);
    });
    child.once("error", () => {
      stop("failed");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (!stopped) settle(code === 0 ? tokenOf(chunks) : failed("failed"));
    });
  });
}

export async function analysisToken(
  folder: string,
  signal?: AbortSignal,
): Promise<AnalysisToken> {
  const setting = process.env["CLOVING_ANALYSIS_TOKEN_COMMAND"];
  if (setting === undefined) return failed("unset");
  const command = commandOf(setting);
  if (command === undefined) return failed("invalid");
  try {
    return await captured(command, { folder, signal });
  } catch {
    return failed("failed");
  }
}
