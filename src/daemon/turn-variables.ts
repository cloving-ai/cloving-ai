import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { cpuShare } from "../queue-room.ts";
import { attachmentEnvironment } from "./attachments.ts";
import { openRuns } from "./working-runs.ts";

export async function turnStartEnvironment(
  settings: { readonly worktrees: string },
  start: {
    readonly intent: { readonly target: string; readonly runId: string };
    readonly profile: { readonly env?: Readonly<Record<string, string>> };
    readonly cores?: number;
  },
): Promise<Readonly<Record<string, string>>> {
  const state = dirname(settings.worktrees);
  const [turns, commands] = await Promise.all([
    openRuns(join(state, "journal")),
    openRuns(join(state, "commands")),
  ]);
  const working = new Set([...turns, ...commands, start.intent.runId]).size;
  const cores = start.cores ?? availableParallelism();
  return {
    ...(await attachmentEnvironment(settings, start)),
    CLOVING_CPU_SHARE: String(cpuShare(cores, working)),
  };
}
