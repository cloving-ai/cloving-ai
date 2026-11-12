import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { restartedEnvironment, restartFiles } from "../restart-request.ts";

const notes = [restartFiles.settings, restartFiles.variables];

function noteText(directory: string, name: string): Promise<string> {
  return readFile(join(directory, name), "utf8").catch(() => "");
}

export async function clearedSettingsNote(directory: string): Promise<void> {
  await Promise.all(
    notes.map((name) => rm(join(directory, name), { force: true })),
  );
}

export async function restartEnvironment(
  directory: string,
  environment: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const settings = await noteText(directory, restartFiles.settings);
  const variables = await noteText(directory, restartFiles.variables);
  await clearedSettingsNote(directory);
  return restartedEnvironment(environment, { settings, variables });
}
