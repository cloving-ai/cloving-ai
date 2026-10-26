import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { record } from "../protocol.ts";

type Environment = Readonly<Record<string, string | undefined>>;

function given(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function quoted(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

export function clientCommand(
  environment: Environment,
  repository?: string,
): string {
  const explicit = environment["CLOVING_RUNTIME_DIR"];
  return given(explicit)
    ? `CLOVING_RUNTIME_DIR=${quoted(explicit)} cloving`
    : `cloving${repository === undefined ? "" : ` --repository ${quoted(repository)}`}`;
}

function stateRoot(environment: Environment): string | undefined {
  const state = environment["XDG_STATE_HOME"];
  if (given(state)) return state;
  const home = environment["HOME"];
  return given(home) ? join(home, ".local", "state") : undefined;
}

function repositoryRuntimeName(repository: string): string {
  const canonical = realpathSync(repository);
  const name = basename(canonical)
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 24);
  const id = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  return `${name}-${id}`;
}

export function adoptionRecordPath(
  environment: Environment,
  repository: string,
): string | undefined {
  const state = stateRoot(environment);
  return state === undefined
    ? undefined
    : join(
        state,
        "cloving",
        "adopted-runtime",
        `${repositoryRuntimeName(repository)}.json`,
      );
}

export function legacyRuntimeDirectory(
  environment: Environment,
): string | undefined {
  const runtime = environment["XDG_RUNTIME_DIR"];
  if (given(runtime)) return join(runtime, "cloving");
  const state = stateRoot(environment);
  return state === undefined ? undefined : join(state, "cloving", "run");
}

function adoptedRuntime(
  environment: Environment,
  repository: string,
): string | undefined {
  const path = adoptionRecordPath(environment, repository);
  if (path === undefined) return undefined;
  try {
    return runtimeRecord(path, repository);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

function runtimeRecord(path: string, repository: string): string {
  const value = record(JSON.parse(readFileSync(path, "utf8")));
  if (
    value?.["schemaVersion"] === 1 &&
    value["repository"] === realpathSync(repository) &&
    typeof value["runtimeDirectory"] === "string" &&
    isAbsolute(value["runtimeDirectory"])
  )
    return value["runtimeDirectory"];
  throw new Error("invalid-runtime-record");
}

export function runtimeDirectory(
  environment: Environment,
  repository?: string,
): string | undefined {
  const explicit = environment["CLOVING_RUNTIME_DIR"];
  if (given(explicit)) return explicit;
  if (repository === undefined) return undefined;
  const adopted = adoptedRuntime(environment, repository);
  if (adopted !== undefined) return adopted;
  const runtime = environment["XDG_RUNTIME_DIR"];
  const root = given(runtime) ? runtime : stateRoot(environment);
  return root === undefined
    ? undefined
    : join(root, "cloving", repositoryRuntimeName(repository), "run");
}
