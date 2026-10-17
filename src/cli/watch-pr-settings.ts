import type { WatchCommandRunner } from "./watch-pr-command.ts";
import { prRepository } from "./watch-pr-identity.ts";
import { prObserver, type PrObserver } from "./watch-pr-observer.ts";

export interface WatchPrSettings {
  readonly repository: string | undefined;
  readonly githubCommand: string | undefined;
  readonly execute: WatchCommandRunner;
}

function githubCommand(given: string | undefined): readonly string[] | null {
  if (given === undefined) return ["gh"];
  try {
    const parsed: unknown = JSON.parse(given);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((part) => typeof part === "string")
    )
      return null;
    return parsed.map(String);
  } catch {
    return null;
  }
}

export async function watchPrObserver(
  settings: WatchPrSettings,
): Promise<PrObserver> {
  const directory = settings.repository;
  const command = githubCommand(settings.githubCommand);
  const output =
    directory === undefined
      ? null
      : await settings
          .execute({
            command: [
              "git",
              "config",
              "--local",
              "--get-all",
              "remote.origin.url",
            ],
            directory,
            signal: AbortSignal.timeout(5000),
          })
          .catch(() => null);
  if (output?.errorCode === "ENOENT" || output?.errorCode === "EACCES")
    return {
      observe: () => ({ status: "unavailable", failure: "command" }),
      close: () => undefined,
    };
  const repository = output?.status === 0 ? prRepository(output.stdout) : null;
  return prObserver({
    repository,
    directory: directory ?? "",
    command,
    execute: settings.execute,
  });
}
