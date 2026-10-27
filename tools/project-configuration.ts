import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { configurationRoot, resolveSettings } from "../src/project-settings.ts";
import { repositoryFileName } from "../src/repository-identity.ts";

async function settingsFile(file: {
  readonly path: string;
  readonly scope: string;
}): Promise<string | undefined> {
  try {
    return await readFile(file.path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw new Error(`unreadable-config-file: ${file.scope}`, { cause: error });
  }
}

export function topLevel(given: string): string {
  try {
    return execFileSync("git", ["-C", given, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return given;
  }
}

export function projectRoot(given: string): Promise<string> {
  return realpath(topLevel(resolve(given)));
}

export async function projectConfiguration(
  repository: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<ReturnType<typeof resolveSettings>> {
  const projectName = repositoryFileName({
    name: basename(repository),
    sha256: createHash("sha256").update(repository).digest("hex"),
  });
  return resolveSettings(environment, {
    project: await settingsFile({
      path: join(repository, ".cloving/config.json"),
      scope: "project",
    }),
    private: await settingsFile({
      path: join(
        configurationRoot(environment, homedir()),
        "cloving/projects",
        `${projectName}.json`,
      ),
      scope: "private",
    }),
  });
}
