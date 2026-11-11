import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { StoredRun } from "../src/record-retention.ts";
import {
  recordSweep,
  type RecordSweep,
  type SweepSettings,
} from "../src/daemon/record-sweep.ts";

export const day = 86_400_000;

export interface SweepScene {
  readonly root: string;
  readonly lines: string[];
  readonly asked: (readonly string[])[];
  readonly folder: (path: string, started: unknown) => Promise<string>;
  readonly settings: (overrides?: Partial<SweepSettings>) => SweepSettings;
  readonly sweep: (overrides?: Partial<SweepSettings>) => RecordSweep;
}

function storedRuns(now: number): Readonly<Record<string, StoredRun>> {
  return {
    done: {
      status: "completed",
      endedAt: now - 40 * day,
    },
    fresh: {
      status: "completed",
      endedAt: now - 10 * day,
    },
    gate: { status: "waiting_gate", endedAt: null },
  };
}

export async function withSweep(
  body: (scene: SweepScene) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cloving-sweep-"));
  const now = Date.now() + 40 * day;
  const runs = storedRuns(now);
  const lines: string[] = [];
  const asked: (readonly string[])[] = [];
  const scene: SweepScene = {
    root,
    lines,
    asked,
    folder: async (path, started) => {
      const folder = join(root, path);
      const staged = await mkdtemp(join(root, ".staged-"));
      await writeFile(
        join(staged, "started.json"),
        typeof started === "string" ? started : JSON.stringify(started),
      );
      await writeFile(join(staged, "result.json"), "{}");
      await mkdir(dirname(folder), { recursive: true });
      await rename(staged, folder);
      return folder;
    },
    settings: (overrides = {}) => ({
      directory: root,
      retention: { days: 30, action: "archive", archiveFolder: null },
      runs: (runIds) => {
        asked.push(runIds);
        return Promise.resolve(
          Object.fromEntries(
            Object.entries(runs).filter(([runId]) => runIds.includes(runId)),
          ),
        );
      },
      now: () => now,
      log: (line) => lines.push(line),
      ...overrides,
    }),
    sweep: (overrides = {}) => recordSweep(scene.settings(overrides)),
  };
  try {
    await body(scene);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
