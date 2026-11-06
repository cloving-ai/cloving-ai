import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { withoutFileVariables } from "../project-settings.ts";
import { restartFiles } from "../restart-request.ts";

function settingsNote(directory: string): string {
  return join(directory, restartFiles.settings);
}

export async function clearedSettingsNote(directory: string): Promise<void> {
  await rm(settingsNote(directory), { force: true });
}

export async function restartEnvironment(
  directory: string,
  environment: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const note = await readFile(settingsNote(directory), "utf8").catch(() => "");
  await clearedSettingsNote(directory);
  return note === "files" ? withoutFileVariables(environment) : environment;
}
