import type { Readable } from "node:stream";

interface ProbeChild {
  readonly pid?: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null) => void): this;
}

interface ProbeEffects {
  readonly spawn: (input: {
    readonly executable: string;
    readonly arguments: string[];
    readonly options: {
      readonly env: Readonly<NodeJS.ProcessEnv>;
      readonly cwd?: string;
      readonly stdio: ["ignore", "pipe", "pipe"];
      readonly detached: true;
    };
  }) => ProbeChild;
  readonly kill: (identifier: number, signal: NodeJS.Signals) => boolean;
}

export interface ProbeOptions {
  readonly arguments: readonly string[];
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly directory?: string;
  readonly milliseconds?: number;
  readonly bytes?: number;
}
export type ProbeRunner = (
  executable: string,
  options: ProbeOptions,
) => Promise<ProbeOutput>;

export interface ProbeOutput {
  readonly exitCode?: number | null;
  readonly stdout: string;
  readonly stderr?: string;
  readonly reason: string | null;
}

function killProbe(child: ProbeChild, effects: ProbeEffects): void {
  if (child.pid === undefined) return;
  try {
    effects.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export function createProbeRunner(effects: ProbeEffects): ProbeRunner {
  return (executable, options) =>
    executeProbe({ executable, options, effects });
}

function executeProbe(input: {
  readonly executable: string;
  readonly options: ProbeOptions;
  readonly effects: ProbeEffects;
}): Promise<ProbeOutput> {
  const { executable, options, effects } = input;
  return new Promise((complete) => {
    const child = effects.spawn({
      executable,
      arguments: [...options.arguments],
      options: {
        env: options.env,
        ...(options.directory === undefined ? {} : { cwd: options.directory }),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let errorBytes = 0;
    let reason: string | null = null;
    const stop = (failure: string): void => {
      if (reason !== null) return;
      reason = failure;
      killProbe(child, effects);
      child.stdout.destroy();
      child.stderr.destroy();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.bytes ?? 65536)) stop("probe-output-limit");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorBytes < (options.bytes ?? 65536)) errors.push(chunk);
      errorBytes += chunk.length;
    });
    const timer = setTimeout(() => {
      stop("probe-timeout");
    }, options.milliseconds ?? 10000);
    child.once("error", () => {
      reason ??= "probe-start";
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      complete({
        exitCode: code,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errors).toString("utf8"),
        reason: reason ?? (code === 0 ? null : "probe-exit"),
      });
    });
  });
}
