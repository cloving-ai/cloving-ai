import { access, constants, lstat, realpath, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { socketAddress } from "../broker/socket-address.ts";
import type { DoctorObservation } from "../doctor-report.ts";
import { record } from "../protocol.ts";
import type { ProbeRunner } from "./probe-command.ts";
import {
  adoptionRecordPath,
  runtimeDirectory,
  legacyRuntimeDirectory,
} from "./runtime-directory.ts";

export interface DoctorRuntime {
  readonly runtime: string | undefined;
  readonly project: string | undefined;
  readonly observation: DoctorObservation;
}

async function writableDirectory(path: string): Promise<string> {
  let existing = path;
  for (;;) {
    try {
      const entry = await stat(existing);
      if (!entry.isDirectory())
        throw new Error(`${existing} is not a directory`);
      await access(existing, constants.W_OK | constants.X_OK);
      return existing;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw new Error(`Folder is not writable: ${existing}`, {
          cause: error,
        });
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

async function runtimePrivacy(path: string): Promise<string> {
  const entry = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
  if (entry === undefined) return "owner and mode will be set at creation";
  if (!entry.isDirectory()) throw new Error("Runtime is not a directory");
  if (entry.uid !== process.getuid?.())
    throw new Error("Runtime owner is a different user");
  const mode = entry.mode & 0o777;
  if ((mode & 0o077) !== 0)
    throw new Error(`Runtime mode ${mode.toString(8)} is not private`);
  return `owner ${String(entry.uid)}, mode ${mode.toString(8)}`;
}

async function selectedRuntime(
  repository: string,
  options: {
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly probe: ProbeRunner;
  },
) {
  const { environment, probe } = options;
  const runtime = runtimeDirectory(environment, repository);
  if (runtime === undefined)
    throw new Error("Runtime directory is not configured");
  const recordPath = adoptionRecordPath(environment, repository);
  if (environment["CLOVING_RUNTIME_DIR"] || recordPath === undefined)
    return { runtime: resolve(runtime), recordPath: undefined };
  const recorded = await lstat(recordPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
  if (recorded !== undefined) return { runtime, recordPath };
  const legacy = legacyRuntimeDirectory(environment);
  if (legacy === undefined) return { runtime, recordPath: undefined };
  const output = await probe(process.execPath, {
    arguments: [
      join(
        import.meta.dirname,
        "../../tools",
        `doctor-adoption${extname(import.meta.filename)}`,
      ),
      resolve(runtime),
      repository,
      resolve(legacy),
      recordPath,
    ],
    env: environment,
  });
  if (output.reason !== null)
    throw new Error("Unable to inspect legacy runtime adoption");
  return parsedSelection(output.stdout, recordPath);
}

function parsedSelection(text: string, recordPath: string) {
  const selected = record(JSON.parse(text));
  const path = selected?.["runtime"];
  if (typeof path !== "string") throw new Error("Invalid runtime selection");
  return {
    runtime: resolve(path),
    recordPath:
      typeof selected?.["adoptionRecord"] === "string" ? recordPath : undefined,
  };
}

async function generatedProjectDirectory(parent: string): Promise<string> {
  const existing = await writableDirectory(parent);
  return join(await realpath(existing), relative(existing, parent), "project");
}

export async function runtimeObservation(
  repository: string,
  options: {
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly probe: ProbeRunner;
  },
): Promise<DoctorRuntime> {
  let runtime: string | undefined;
  let project: string | undefined;
  try {
    const selected = await selectedRuntime(repository, options);
    const runtimePath = selected.runtime;
    runtime = runtimePath;
    const privacy = await runtimePrivacy(runtime);
    project = await generatedProjectDirectory(dirname(runtime));
    const address = socketAddress(join(runtime, "control.sock"), {
      directory: project,
    });
    if (address.kind === "refused") throw new Error(address.detail);
    const paths = [
      runtime,
      dirname(runtime),
      ...[
        "project",
        "workflow-bundles",
        "state",
        "world",
        "journal",
        "worktrees",
        "github",
        "handoffs",
      ].map((folder) => join(dirname(runtimePath), folder)),
    ];
    if (selected.recordPath !== undefined)
      paths.push(dirname(selected.recordPath));
    for (const path of paths) await writableDirectory(path);
    return {
      runtime,
      project,
      observation: {
        result: "ok",
        detail: `${runtime}; socket ${address.path} (${String(Buffer.byteLength(address.path))} bytes); ${privacy}; runtime, parent, adoption record and start folders are writable`,
      },
    };
  } catch (error) {
    return {
      runtime,
      project,
      observation: {
        result: "fail",
        detail:
          error instanceof Error ? error.message : "Runtime inspection failed",
      },
    };
  }
}

export async function serviceObservation(
  location: DoctorRuntime,
  options: {
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly probe: ProbeRunner;
  },
): Promise<DoctorObservation> {
  const { environment, probe } = options;
  const { runtime, project } = location;
  if (
    runtime === undefined ||
    project === undefined ||
    location.observation.result !== "ok"
  )
    return { result: "skip", detail: "Runtime prerequisite unavailable" };
  const entry = await lstat(join(runtime, "control.sock")).catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    },
  );
  if (entry === undefined)
    return { result: "skip", detail: "No service for this repository" };
  const result = await probe(process.execPath, {
    arguments: [
      join(
        import.meta.dirname,
        `doctor-service${extname(import.meta.filename)}`,
      ),
      runtime,
    ],
    env: environment,
    directory: project,
    milliseconds: 5000,
  });
  const usable =
    result.reason === null &&
    record(JSON.parse(result.stdout))?.["kind"] === "result";
  return {
    result: usable ? "ok" : "fail",
    detail: usable
      ? "Service answers from its generated project folder"
      : "Service did not answer successfully within 5 seconds",
  };
}
