import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import timers from "node:timers/promises";
import type { ObservationReport } from "../src/service/worker-port.ts";
import type { GithubScene } from "./github-worker-fixture.ts";

export interface GitFailure {
  readonly command: string;
  readonly mode: "fail" | "append";
  readonly outputs: readonly string[];
}

export interface FakeGit {
  readonly environment: Readonly<Record<string, string>>;
  readonly fail: (failure: GitFailure) => void;
  readonly invoked: (command: string) => readonly (readonly string[])[];
}

export interface Observed {
  readonly observations: readonly ObservationReport[];
  readonly observe: (
    report: ObservationReport,
  ) => Promise<{ readonly kind: string }>;
}

export interface Shown {
  readonly condition: string;
  readonly reason: string;
  readonly evidence: string | undefined;
  readonly attempt: number | undefined;
  readonly limit: number | undefined;
}

export const gitWaits: readonly number[] = [5_000, 15_000, 45_000];

export const publicKeyRefusal =
  "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n";

function script(files: {
  readonly plan: string;
  readonly log: string;
  readonly executable: string;
}): string {
  return `#!/usr/bin/env -S -u NODE_V8_COVERAGE ${process.execPath}
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const parts = process.argv.slice(2);
const planFile = ${JSON.stringify(files.plan)};
appendFileSync(${JSON.stringify(files.log)}, parts.join("\\t") + "\\n");
const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, "utf8")) : { outputs: [] };
const planned = parts[0] === plan.command && plan.outputs.length > 0;
if (planned) writeFileSync(planFile, JSON.stringify({ ...plan, outputs: plan.outputs.slice(1) }));
if (planned && plan.mode === "fail") {
  process.stderr.write(plan.outputs[0]);
  process.exitCode = 128;
} else {
  const result = spawnSync(${JSON.stringify(files.executable)}, parts, { stdio: ["inherit", "inherit", "pipe"] });
  process.stderr.write(result.stderr);
  if (planned) process.stderr.write(plan.outputs[0]);
  process.exitCode = result.status ?? 1;
}
`;
}

function lines(file: string): readonly (readonly string[])[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\t"));
}

export function fakeGit(scene: GithubScene): FakeGit {
  const folder = join(scene.directory, "fake-git");
  mkdirSync(folder);
  const plan = join(folder, "plan.json");
  const log = join(folder, "calls.log");
  const executable = execFileSync("which", ["git"], {
    encoding: "utf8",
  }).trim();
  writeFileSync(join(folder, "git"), script({ plan, log, executable }), {
    mode: 0o700,
  });
  return {
    environment: {
      FAKE_GH_STATE: join(scene.directory, "gh-state.json"),
      FAKE_GH_ORIGIN: scene.origin,
      PATH: `${folder}:${process.env["PATH"] ?? ""}`,
    },
    fail: (failure) => {
      writeFileSync(plan, JSON.stringify(failure));
    },
    invoked: (command) => lines(log).filter((parts) => parts[0] === command),
  };
}

export async function withGitWaits(
  use: (waits: readonly number[]) => Promise<void>,
): Promise<void> {
  const sleep = timers.setTimeout;
  const waits: number[] = [];
  Object.defineProperty(timers, "setTimeout", {
    configurable: true,
    value: (milliseconds = 1) => {
      if (!gitWaits.includes(milliseconds)) return sleep(milliseconds);
      waits.push(milliseconds);
      return Promise.resolve();
    },
  });
  syncBuiltinESMExports();
  try {
    await use(waits);
  } finally {
    timers.setTimeout = sleep;
    syncBuiltinESMExports();
  }
}

export function observing(): Observed {
  const observations: ObservationReport[] = [];
  return {
    observations,
    observe: (report) => {
      observations.push(report);
      return Promise.resolve({ kind: "accepted" });
    },
  };
}

export function shown(report: ObservationReport): Shown {
  const { condition, reason, evidence, attempt, limit } = report;
  return { condition, reason, evidence, attempt, limit };
}
