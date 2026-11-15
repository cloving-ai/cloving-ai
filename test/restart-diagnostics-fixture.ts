import type { CliResult } from "./service-fixture.ts";
import type { Scene } from "./self-host-fixture.ts";
import { eventually, runCli } from "./service-fixture.ts";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { record } from "../src/protocol.ts";

interface DiagnosticScene {
  readonly fixture: { readonly directory: string };
  readonly output: () => string;
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
    throw new Error(
      `${message}\nRestart diagnostics before cleanup: ${JSON.stringify({ host: scene.output(), files: Object.fromEntries(files) })}`,
      { cause: error },
    );
  }
}

export async function restartCli(
  fixture: Scene,
  options: readonly string[],
): Promise<CliResult> {
  const started = Date.now();
  const entryPoint = fixture.entryPoint;
  const file = join(fixture.directory, "restart-cli.json");
  await writeFile(file, JSON.stringify({ started, options, entryPoint }));
  const result = await runCli(["restart", ...options, "--json"], {
    directory: fixture.repository,
    runtime: fixture.runtimeDirectory,
    entryPoint,
  });
  await writeFile(
    file,
    JSON.stringify({
      started,
      ended: Date.now(),
      options,
      entryPoint,
      ...result,
    }),
  );
  return result;
}
