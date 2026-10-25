import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliveryIntent } from "../src/broker/actor/delivery-intents.ts";
import {
  commandWorker,
  type CommandWorkerSettings,
} from "../src/daemon/command-worker.ts";
import type { WorkerReport } from "../src/daemon/operation-journal.ts";
import { located } from "../src/daemon/operation-journal.ts";

export const signal = new AbortController().signal;

export function commandIntent(
  overrides: Partial<DeliveryIntent> = {},
): DeliveryIntent {
  return {
    kind: "protected-effect",
    runId: "run-1",
    operationId: "operation-1",
    workflow: "sha256:workflow",
    inputDigest: "sha256:input",
    purpose: "dispatch",
    leaseGeneration: 1,
    capability: "command",
    method: "run:scan",
    target: "scan",
    payload: "sha256:payload",
    ...overrides,
  };
}

export async function withCommandScene(
  use: (scene: {
    readonly directory: string;
    readonly journal: string;
    readonly reports: WorkerReport[];
    readonly worker: (
      source: string,
      overrides?: Partial<CommandWorkerSettings>,
    ) => ReturnType<typeof commandWorker>;
    readonly recorded: (name: string) => string;
  }) => Promise<void>,
): Promise<void> {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "cloving-command-")),
  );
  const journal = join(directory, "journal");
  const reports: WorkerReport[] = [];
  const workers: ReturnType<typeof commandWorker>[] = [];
  try {
    await use({
      directory,
      journal,
      reports,
      recorded: (name) =>
        readFileSync(
          join(located(journal, "operation-1").folder, name),
          "utf8",
        ),
      worker: (source, overrides = {}) => {
        const worker = commandWorker({
          repository: directory,
          journal,
          commands: { scan: [process.execPath, "-e", source] },
          document: () => Promise.resolve('{"value":"hello"}'),
          report: (report) => {
            reports.push(report);
            return Promise.resolve();
          },
          ...overrides,
        });
        workers.push(worker);
        return worker;
      },
    });
  } finally {
    for (const worker of workers) await worker.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
