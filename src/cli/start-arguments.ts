import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  adoptionRecordPath,
  clientCommand,
  clientProgram,
  legacyRuntimeDirectory,
  runtimeDirectory,
} from "./runtime-directory.ts";

export interface StartRequest {
  readonly runtime: string;
  readonly argumentsList: readonly string[];
  readonly repository: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
}

export type StartSelection =
  | { readonly kind: "usage" }
  | { readonly kind: "refused"; readonly text: string }
  | { readonly kind: "workspace"; readonly options: readonly string[] }
  | { readonly kind: "repository"; readonly directory: string | undefined };

export function startSelection(options: readonly string[]): StartSelection {
  if (options.includes("--help")) return { kind: "usage" };
  const parsed = parseArgs({
    args: [...options],
    options: { repository: { type: "string" } },
    strict: false,
    allowPositionals: true,
  });
  const selected = parsed.values["repository"];
  const given = Object.hasOwn(parsed.values, "repository");
  if (given && (typeof selected !== "string" || selected === ""))
    return {
      kind: "refused",
      text: "missing-value: --repository needs a directory.\n",
    };
  if (parsed.positionals.length > 0)
    return {
      kind: "refused",
      text: "unexpected-argument: run cloving start --help for usage.\n",
    };
  if (!options.includes("--workspace"))
    return {
      kind: "repository",
      directory: typeof selected === "string" ? selected : undefined,
    };
  if (given)
    return {
      kind: "refused",
      text: "unexpected-argument: --workspace and --repository do not go together.\n",
    };
  return {
    kind: "workspace",
    options: options.filter((option) => option !== "--workspace"),
  };
}

export function startArguments(input: StartRequest): readonly string[] {
  const { runtime, repository, argumentsList } = input;
  const located = [
    "--runtime",
    runtimeDirectory(process.env, repository) ?? runtime,
    "--repository",
    repository ?? process.cwd(),
    "--client",
    clientCommand(process.env, { repository }),
    "--client-program",
    clientProgram(),
  ];
  const record =
    repository === undefined
      ? undefined
      : adoptionRecordPath(process.env, repository);
  const legacy = legacyRuntimeDirectory(process.env);
  if (
    !process.env["CLOVING_RUNTIME_DIR"] &&
    record !== undefined &&
    !existsSync(record) &&
    legacy !== undefined
  )
    located.push(
      "--legacy-runtime",
      resolve(legacy),
      "--adoption-record",
      resolve(record),
    );
  return [...located, ...argumentsList];
}

export function currentRuntime(start: {
  readonly repository: string | undefined;
  readonly runtime: string;
}): string {
  return runtimeDirectory(process.env, start.repository) ?? start.runtime;
}
