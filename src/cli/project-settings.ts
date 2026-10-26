import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configurationRoot, resolveSettings } from "../project-settings.ts";
import { repositoryRuntimeName } from "./runtime-directory.ts";

export function privateSettingsPath(
  environment: Readonly<NodeJS.ProcessEnv>,
  repository: string,
): string {
  return join(
    configurationRoot(environment, homedir()),
    "cloving/projects",
    `${repositoryRuntimeName(repository)}.json`,
  );
}

function read(file: {
  readonly path: string;
  readonly scope: string;
}): string | undefined {
  try {
    return readFileSync(file.path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw new Error(`unreadable-config-file: ${file.scope}`, { cause: error });
  }
}

export function projectSettings(
  environment: Readonly<NodeJS.ProcessEnv>,
  repository: string,
): ReturnType<typeof resolveSettings> {
  return resolveSettings(environment, {
    project: read({
      path: join(repository, ".cloving/config.json"),
      scope: "project",
    }),
    private: read({
      path: privateSettingsPath(environment, repository),
      scope: "private",
    }),
  });
}

export function settingsEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  repository: string,
): Readonly<NodeJS.ProcessEnv> {
  return projectSettings(environment, repository).environment;
}
