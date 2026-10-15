import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliveryIntent } from "../src/broker/actor/delivery-intents.ts";
import {
  githubWorker,
  type GithubWorker,
  type GithubWorkerSettings,
} from "../src/daemon/github-worker.ts";
import type { WorkerReport } from "../src/daemon/operation-journal.ts";
import { git, until } from "./claude-worker-fixture.ts";

import { fakeGh } from "./github-api-fixture.ts";
export { fakeGh } from "./github-api-fixture.ts";

export interface GithubState {
  readonly prs: readonly Readonly<Record<string, unknown>>[];
  readonly calls: readonly (readonly string[])[];
  readonly triggers: readonly number[];
}

export interface Plan {
  readonly scores: readonly number[];
  readonly headAfterReads?: number;
  readonly mergeRefusals?: number;
  readonly mergeStatus?: number;
  readonly mergePollMilliseconds?: number;
  readonly failureText?: string;
  readonly issuePages?: readonly (readonly unknown[])[];
  readonly waitForTrigger?: boolean;
  readonly fail?: string;
  readonly garble?: string;
  readonly replies?: Readonly<Record<string, unknown>>;
}

export interface GithubScene {
  readonly directory: string;
  readonly origin: string;
  readonly repository: string;
  readonly worktrees: string;
  readonly journal: string;
  readonly reports: WorkerReport[];
  readonly state: () => GithubState;
  readonly plan: (plan: Plan) => void;
  readonly worker: (overrides?: Partial<GithubWorkerSettings>) => GithubWorker;
  readonly unscanned: (
    overrides?: Partial<GithubWorkerSettings>,
  ) => GithubWorker;
  readonly gh: (parts: readonly string[]) => string;
  readonly perform: (
    worker: GithubWorker,
    call: { readonly method: string; readonly payload: unknown },
  ) => Promise<WorkerReport>;
}

export function ghState(plan: Plan): string {
  return JSON.stringify({
    prs: [],
    issues: [],
    calls: [],
    triggers: [],
    reviewed: {},
    latest: {},
    reviewComments: [],
    waitForTrigger: false,
    ...plan,
    scores: [...plan.scores],
  });
}

export const fastTiming = {
  pollMilliseconds: 10,
  triggerMilliseconds: 150,
  limitMilliseconds: 600,
};

export function githubIntent(
  overrides: Partial<DeliveryIntent> = {},
): DeliveryIntent {
  return {
    kind: "protected-effect",
    runId: "run-1",
    operationId: "operation-1",
    workflow: "sha256:pin",
    inputDigest: `sha256:${"a".repeat(64)}`,
    purpose: "dispatch",
    leaseGeneration: 1,
    capability: "github",
    method: "prepare",
    target: "ticket/one",
    payload: "sha256:payload-1",
    ...overrides,
  };
}

function seeded(directory: string): { origin: string; repository: string } {
  const origin = join(directory, "origin.git");
  execFileSync("git", [
    "init",
    "--quiet",
    "--bare",
    "--initial-branch",
    "main",
    origin,
  ]);
  const repository = join(directory, "repository");
  execFileSync("git", ["clone", "--quiet", origin, repository], {
    stdio: "ignore",
  });
  for (const [name, value] of [
    ["user.name", "Cloving Test"],
    ["user.email", "test@cloving.invalid"],
    ["commit.gpgsign", "false"],
  ] as const)
    git(repository, ["config", name, value]);
  writeFileSync(join(repository, "README.md"), "The fixture project.\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "Start the project"]);
  git(repository, ["push", "--quiet", "origin", "main"]);
  git(repository, ["remote", "set-head", "origin", "main"]);
  return { origin, repository };
}

interface Kept {
  readonly directory: string;
  readonly script: string;
  readonly stateFile: string;
  readonly origin: string;
  readonly repository: string;
  readonly reports: WorkerReport[];
  readonly payloads: Map<string, string>;
  readonly workers: GithubWorker[];
  readonly scans: Promise<void>[];
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}

function stateOf(file: string): GithubState {
  const fields = record(JSON.parse(readFileSync(file, "utf8")));
  return {
    prs: listOf(fields["prs"]).map(record),
    calls: listOf(fields["calls"]).map((call) => listOf(call).map(String)),
    triggers: listOf(fields["triggers"]).map(Number),
  };
}

function planned(file: string, plan: Plan): void {
  const current = record(JSON.parse(readFileSync(file, "utf8")));
  writeFileSync(
    file,
    JSON.stringify({ ...current, ...plan, scores: [...plan.scores] }),
  );
}

function made(
  kept: Kept,
  overrides: Partial<GithubWorkerSettings>,
): GithubWorker {
  const { stateFile, origin, payloads, reports } = kept;
  const worker = githubWorker({
    repository: kept.repository,
    worktrees: join(kept.directory, "worktrees"),
    journal: join(kept.directory, "github"),
    gh: [process.execPath, kept.script],
    environment: { FAKE_GH_STATE: stateFile, FAKE_GH_ORIGIN: origin },
    timing: fastTiming,
    document: (digest) => Promise.resolve(payloads.get(digest)),
    operationStatus: () => Promise.resolve("running"),
    runStatus: () => Promise.resolve("running"),
    report: (report) => {
      reports.push(report);
      return Promise.resolve();
    },
    ...overrides,
  });
  kept.workers.push(worker);
  return worker;
}

function scanned(kept: Kept, worker: GithubWorker): GithubWorker {
  kept.scans.push(worker.scan());
  return worker;
}

function called(kept: Kept, parts: readonly string[]): string {
  return execFileSync(process.execPath, [kept.script, ...parts], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_GH_STATE: kept.stateFile,
      FAKE_GH_ORIGIN: kept.origin,
    },
  });
}

async function performed(
  kept: Kept,
  run: {
    readonly worker: GithubWorker;
    readonly call: Parameters<GithubScene["perform"]>[1];
  },
): Promise<WorkerReport> {
  const { reports, payloads } = kept;
  const operationId = `operation-${String(reports.length + payloads.size + 1)}`;
  const digest = `sha256:${operationId}`;
  payloads.set(digest, JSON.stringify(run.call.payload));
  const given = githubIntent({
    operationId,
    method: run.call.method,
    payload: digest,
  });
  await run.worker.deliver(given, new AbortController().signal);
  await until(() => reports.some((item) => item.operationId === operationId));
  const report = reports.find((item) => item.operationId === operationId);
  if (report === undefined) throw new Error("no report");
  return report;
}

function sceneOf(kept: Kept): GithubScene {
  return {
    directory: kept.directory,
    origin: kept.origin,
    repository: kept.repository,
    worktrees: join(kept.directory, "worktrees"),
    journal: join(kept.directory, "github"),
    reports: kept.reports,
    state: () => stateOf(kept.stateFile),
    plan: (plan) => {
      planned(kept.stateFile, plan);
    },
    worker: (overrides = {}) => scanned(kept, made(kept, overrides)),
    unscanned: (overrides = {}) => made(kept, overrides),
    gh: (parts) => called(kept, parts),
    perform: (worker, call) => performed(kept, { worker, call }),
  };
}

export async function withGithub<Result>(
  use: (scene: GithubScene) => Promise<Result>,
): Promise<Result> {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "cloving-github-")),
  );
  const kept: Kept = {
    directory,
    script: join(directory, "fake-gh.mjs"),
    stateFile: join(directory, "gh-state.json"),
    ...seeded(directory),
    reports: [],
    payloads: new Map(),
    workers: [],
    scans: [],
  };
  writeFileSync(kept.script, fakeGh);
  writeFileSync(kept.stateFile, ghState({ scores: [] }));
  try {
    return await use(sceneOf(kept));
  } finally {
    await Promise.all(kept.scans);
    await Promise.all(kept.workers.map((worker) => worker.close()));
    rmSync(directory, { recursive: true, force: true });
  }
}

export function committed(
  tree: string,
  change: { readonly name: string; readonly text: string },
): string {
  mkdirSync(join(tree, "src"), { recursive: true });
  writeFileSync(join(tree, "src", change.name), change.text);
  git(tree, ["add", "."]);
  git(tree, ["commit", "--quiet", "-m", `Change ${change.name}`]);
  return git(tree, ["rev-parse", "HEAD"]);
}

export const pullTitle = "CLV-063: Add the change";
export const pullBody = "Closes #63";

export function treeOf(scene: GithubScene): string {
  return join(scene.worktrees, "ticket-one");
}

export async function opened(
  scene: GithubScene,
  worker: ReturnType<GithubScene["worker"]>,
): Promise<string> {
  await scene.perform(worker, { method: "prepare", payload: {} });
  const commit = committed(treeOf(scene), { name: "one.ts", text: "1;\n" });
  await scene.perform(worker, {
    method: "open-pr",
    payload: { title: pullTitle, body: pullBody },
  });
  return commit;
}
