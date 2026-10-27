import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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
