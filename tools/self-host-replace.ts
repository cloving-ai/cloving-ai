import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { withoutFileVariables } from "../src/project-settings.ts";
import { restartFiles } from "../src/restart-request.ts";

export interface EndedHost {
  readonly directory: string;
  readonly runtime: string;
  readonly status: number;
}

const pairFlags = ["--runtime", "--legacy-runtime", "--adoption-record"];

function droppedFlag(argument: string): boolean {
  return (
    argument === "--reset-queue" ||
    pairFlags.some(
      (flag) => argument === flag || argument.startsWith(`${flag}=`),
    )
  );
}

function keptArguments(argumentsList: readonly string[]): readonly string[] {
  return argumentsList.filter(
    (argument, index) =>
      !droppedFlag(argument) &&
      !pairFlags.includes(argumentsList[index - 1] ?? ""),
  );
}

async function restartEnvironment(
  directory: string,
): Promise<NodeJS.ProcessEnv> {
  const note = join(directory, restartFiles.settings);
  const settings = await readFile(note, "utf8").catch(() => "");
  await rm(note, { force: true });
  return settings === "files" ? withoutFileVariables(process.env) : process.env;
}

export async function replacedHost(host: EndedHost): Promise<number> {
  if (host.status !== 75 || process.execve === undefined) return host.status;
  const environment = await restartEnvironment(host.directory);
  const [, entry = "", ...given] = process.argv;
  return process.execve(
    process.execPath,
    [
      process.execPath,
      ...process.execArgv,
      entry,
      "--runtime",
      host.runtime,
      ...keptArguments(given),
    ],
    environment,
  );
}
