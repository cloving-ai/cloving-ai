import { access, constants, stat } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import type { DoctorObservation } from "../doctor-report.ts";
import { qualifiedNode } from "./toolchain.ts";

export function listedSetting(
  text: string | undefined,
): readonly string[] | undefined {
  try {
    const list: unknown = JSON.parse(text ?? "null");
    if (
      Array.isArray(list) &&
      list.every(
        (item: unknown) => typeof item === "string" && !item.includes("\0"),
      )
    )
      return list.map(String);
  } catch {
    return undefined;
  }
  return undefined;
}

export function nodeObservation(version: string): DoctorObservation {
  return {
    result: version === qualifiedNode ? "ok" : "fail",
    detail: `Node ${version}; workflow admission requires ${qualifiedNode}`,
  };
}

export async function executableProgram(
  program: string,
  location: {
    readonly directory: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
  },
): Promise<string | undefined> {
  return accessibleFile(program, { ...location, mode: constants.X_OK });
}

export async function accessibleFile(
  program: string,
  location: {
    readonly directory: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly mode: number;
  },
): Promise<string | undefined> {
  const paths = program.includes("/")
    ? [program]
    : (location.environment["PATH"] ?? "")
        .split(delimiter)
        .map((directory) => resolve(location.directory, directory, program));
  for (const candidate of paths) {
    const path = resolve(location.directory, candidate);
    try {
      await access(path, location.mode);
      if ((await stat(path)).isFile()) return path;
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function commandObservation(
  text: string | undefined,
  location: {
    readonly directory: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
  },
): Promise<DoctorObservation> {
  const command = listedSetting(text);
  const program = command?.[0];
  if (!program)
    return { result: "fail", detail: "An executable command list is required" };
  const path = await executableProgram(program, location);
  return {
    result: path === undefined ? "fail" : "ok",
    detail: `${JSON.stringify(command)} from ${location.directory}; ${path ?? "program is not executable"}. Availability now does not guarantee an untracked file exists in a later worktree`,
  };
}

export function queueObservation(text: string | undefined): DoctorObservation {
  const seconds = Number(text);
  const valid =
    text !== undefined &&
    /^\d+$/.test(text) &&
    Number.isInteger(seconds) &&
    seconds >= 10 &&
    seconds <= 3600;
  return {
    result: valid ? "ok" : "fail",
    detail: valid
      ? `${String(seconds)} seconds`
      : "queue.everySeconds must be a whole number from 10 to 3600",
  };
}

export function privateTextsObservation(
  text: string | undefined,
): DoctorObservation {
  const valid =
    listedSetting(text)?.some((value) => value.trim().length > 0) === true;
  return {
    result: valid ? "ok" : "fail",
    detail: valid
      ? "Nonblank private texts configured"
      : "privateTexts needs at least one nonblank text",
  };
}
