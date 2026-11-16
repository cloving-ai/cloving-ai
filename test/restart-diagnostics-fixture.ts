import type { CliResult } from "./service-fixture.ts";
import type { Scene } from "./self-host-fixture.ts";
import { eventually, runCli } from "./service-fixture.ts";
import { readFile, readdir, writeFile } from "node:fs/promises";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { record } from "../src/protocol.ts";

interface DiagnosticScene {
  readonly fixture: { readonly directory: string };
  readonly output: () => string;
}

export interface RestartDeadlineDiagnostics {
  phase: string;
  host: string;
  directory: string | undefined;
  readonly close: () => void;
}

function boundedDiagnosticFile(path: string): string {
  try {
    const file = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!fstatSync(file).isFile()) return "not a regular file";
      const bytes = Buffer.alloc(1000);
      return bytes.subarray(0, readSync(file, bytes)).toString("utf8");
    } finally {
      closeSync(file);
    }
  } catch (error) {
    return String(error);
  }
}

function diagnosticFiles(directory: string | undefined) {
  if (directory === undefined) return {};
  try {
    const names = readdirSync(directory).filter((name) =>
      name.includes("restart"),
    );
    return Object.fromEntries(
      names
        .slice(0, 4)
        .map((name) => [name, boundedDiagnosticFile(join(directory, name))]),
    );
  } catch (error) {
    return { error: String(error) };
  }
}

function deadlineSnapshot(state: RestartDeadlineDiagnostics): string {
  return JSON.stringify({
    phase: state.phase,
    host: state.host.slice(-3000),
    files: diagnosticFiles(state.directory),
  }).slice(0, 8000);
}

export function restartDeadlineDiagnostics(
  signal: AbortSignal,
): RestartDeadlineDiagnostics {
  const state: RestartDeadlineDiagnostics = {
    phase: "setup",
    host: "",
    directory: undefined,
    close: () => {
      signal.removeEventListener("abort", capture);
    },
  };
  const capture = (): void => {
    let snapshot: string;
    try {
      snapshot = deadlineSnapshot(state);
    } catch (error) {
      snapshot = JSON.stringify({ phase: state.phase, error: String(error) });
    }
    const message = `Restart deadline diagnostics: ${snapshot}`;
    const reason: unknown = signal.reason;
    if (reason instanceof Error)
      Object.defineProperty(reason, "message", {
        value: `${reason.message}\n${message}`,
        configurable: true,
      });
    writeSync(process.stderr.fd, `${message}\n`);
  };
  signal.addEventListener("abort", capture, { once: true });
  if (signal.aborted) capture();
  return state;
}

export function restartPhases(output: string) {
  return output.split("\n").flatMap((line) => {
    try {
      const entry = record(JSON.parse(line));
      const phase = entry?.["phase"];
      const at = entry?.["at"];
      const processId = entry?.["processId"];
      return typeof phase === "string" &&
        typeof at === "number" &&
        typeof processId === "number"
        ? [{ phase, at, processId }]
        : [];
    } catch {
      return [];
    }
  });
}

export async function replacementPhases(input: {
  readonly output: () => string;
  readonly requested: number;
  readonly startedAt: number;
  readonly required?: readonly string[];
}) {
  return await eventually(() => {
    const phases = restartPhases(input.output()).filter(
      (entry) => entry.at >= input.requested,
    );
    const identity = phases.find(
      (entry) =>
        entry.phase === "service-identity" && entry.at >= input.startedAt,
    );
    if (identity === undefined) return undefined;
    const service = phases.filter(
      (entry) =>
        entry.processId === identity.processId && entry.at >= identity.at,
    );
    const ready = service.find((entry) => entry.phase === "listener-ready");
    if (
      ready === undefined ||
      !service.some((entry) => entry.phase === "recovery-end")
    )
      return undefined;
    const required = input.required ?? [];
    if (
      !required.every((phase) => phases.some((entry) => entry.phase === phase))
    )
      return undefined;
    return { phases, ready };
  });
}

function requestTime(invocation: string | undefined): unknown {
  try {
    return record(JSON.parse(invocation ?? "{}"))?.["started"];
  } catch {
    return undefined;
  }
}

function phaseTimeline(
  output: string,
  invocation: string | undefined,
): readonly string[] {
  const started = requestTime(invocation);
  if (typeof started !== "number") return [];
  const entries = restartPhases(output)
    .filter((entry) => entry.at >= started)
    .map(
      (entry) =>
        `${String(entry.at - started)} ${entry.phase} ${String(entry.processId)}`,
    );
  const lines = [
    "Restart phase times: milliseconds after the request, phase, process",
  ];
  for (const entry of entries) {
    const last = lines.length > 1 ? (lines.at(-1) ?? "") : "";
    if (last === "" || last.length + entry.length > 450) lines.push(entry);
    else lines[lines.length - 1] = `${last}, ${entry}`;
  }
  return lines.slice(0, 9);
}

export async function diagnosedRestartScene<Value extends DiagnosticScene>(
  scene: Value,
  body: (scene: Value) => Promise<void>,
): Promise<void> {
  try {
    await body(scene);
  } catch (error) {
    const directory = scene.fixture.directory;
    const notes = (await readdir(directory)).filter((name) =>
      name.includes("restart"),
    );
    const files = await Promise.all(
      notes.map(
        async (name) =>
          [
            name,
            await readFile(join(directory, name), "utf8").catch(
              (error: unknown) => String(error),
            ),
          ] as const,
      ),
    );
    const message = error instanceof Error ? error.message : String(error);
    const notesByName = Object.fromEntries(files);
    const timeline = phaseTimeline(
      scene.output(),
      notesByName["restart-cli.json"],
    );
    throw new Error(
      [
        message,
        `Restart diagnostics before cleanup: ${JSON.stringify({ host: scene.output(), files: notesByName })}`,
        ...timeline,
      ].join("\n"),
      { cause: error },
    );
  }
}

export async function restartCli(
  fixture: Scene,
  options: {
    readonly arguments: readonly string[];
    readonly signal?: AbortSignal;
  },
): Promise<CliResult> {
  const started = Date.now();
  const entryPoint = fixture.entryPoint;
  const file = join(fixture.directory, "restart-cli.json");
  await writeFile(
    file,
    JSON.stringify({ started, options: options.arguments, entryPoint }),
  );
  const result = await runCli(["restart", ...options.arguments, "--json"], {
    directory: fixture.repository,
    runtime: fixture.runtimeDirectory,
    entryPoint,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    observe: (output) => {
      writeFileSync(
        file,
        JSON.stringify({
          started,
          options: options.arguments,
          entryPoint,
          phase: "cli-pending",
          stdout: output.stdout.slice(-1000),
          stderr: output.stderr.slice(-1000),
        }),
      );
    },
  });
  await writeFile(
    file,
    JSON.stringify({
      started,
      ended: Date.now(),
      options: options.arguments,
      entryPoint,
      ...result,
    }),
  );
  return result;
}
