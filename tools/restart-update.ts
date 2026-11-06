import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface CheckoutCommands {
  readonly git: (argumentsList: readonly string[]) => Promise<string>;
  readonly npm: (argumentsList: readonly string[]) => Promise<string>;
  readonly stopping: AbortSignal;
}

export type UpdateStep =
  "fetch" | "branch" | "fast-forward" | "clean" | "merge" | "install" | "build";

interface FailedUpdate {
  readonly kind: "failed";
  readonly step: UpdateStep;
  readonly output: string;
}

interface SkippedUpdate {
  readonly kind: "skipped";
  readonly step: "clean";
  readonly output: string;
}

export type CheckoutUpdate =
  | { readonly kind: "updated"; readonly from: string; readonly to: string }
  | SkippedUpdate
  | FailedUpdate;

export type Stepped<Value> =
  { readonly kind: "done"; readonly value: Value } | FailedUpdate;

interface UpdatePlan {
  readonly head: string;
  readonly target: string;
  readonly install: boolean;
}

const outputLimit = 4000;

function outputOf(error: unknown): string {
  const fields: Record<string, unknown> =
    typeof error === "object" && error !== null ? { ...error } : {};
  const streams = [fields["stdout"], fields["stderr"]]
    .filter((stream) => typeof stream === "string")
    .map((stream) => stream.trimEnd())
    .filter((stream) => stream !== "");
  const text = streams.length > 0 ? streams.join("\n") : String(error);
  return text.slice(-outputLimit);
}

function failedAt(step: UpdateStep, output: string): FailedUpdate {
  return { kind: "failed", step, output };
}

export async function stepped<Value>(
  step: UpdateStep,
  work: () => Promise<Value>,
): Promise<Stepped<Value>> {
  try {
    return { kind: "done", value: await work() };
  } catch (error) {
    return failedAt(step, outputOf(error));
  }
}

async function fetchedBranch(git: CheckoutCommands["git"]): Promise<string> {
  await git(["fetch", "origin"]);
  await git(["remote", "set-head", "origin", "--auto"]);
  return (await git(["symbolic-ref", "refs/remotes/origin/HEAD"])).trim();
}

async function changedFiles(git: CheckoutCommands["git"]): Promise<string> {
  const status = await git([
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  const hidden = (await git(["ls-files", "-v"]))
    .split("\n")
    .filter((line) => /^[a-zS] /.test(line));
  return [status.trimEnd(), ...hidden].filter((line) => line !== "").join("\n");
}

async function fastForward(
  git: CheckoutCommands["git"],
  remote: string,
): Promise<readonly [string, string]> {
  const head = (await git(["rev-parse", "HEAD"])).trim();
  const target = (await git(["rev-parse", remote])).trim();
  await git(["merge-base", "--is-ancestor", head, target]);
  return [head, target];
}

async function checkedBranch(
  git: CheckoutCommands["git"],
): Promise<Stepped<string>> {
  const remote = await stepped("fetch", () => fetchedBranch(git));
  if (remote.kind === "failed") return remote;
  const branch = remote.value.replace("refs/remotes/origin/", "refs/heads/");
  const current = await stepped("branch", async () =>
    (await git(["symbolic-ref", "HEAD"])).trim(),
  );
  if (current.kind === "failed") return current;
  if (current.value === branch) return remote;
  return failedAt(
    "branch",
    `The checkout is on ${current.value}. The update needs ${branch}.`,
  );
}

async function updatePlan(
  git: CheckoutCommands["git"],
): Promise<Stepped<UpdatePlan> | SkippedUpdate> {
  const changes = await stepped("clean", () => changedFiles(git));
  if (changes.kind === "failed") return changes;
  if (changes.value !== "")
    return { kind: "skipped", step: "clean", output: changes.value };
  const remote = await checkedBranch(git);
  if (remote.kind === "failed") return remote;
  const commits = await stepped("fast-forward", () =>
    fastForward(git, remote.value),
  );
  if (commits.kind === "failed") return commits;
  const [head, target] = commits.value;
  const install = await git([
    "diff",
    "--quiet",
    head,
    target,
    "--",
    "package-lock.json",
  ]).then(
    () => false,
    () => true,
  );
  return { kind: "done", value: { head, target, install } };
}

async function built(
  commands: CheckoutCommands,
  plan: UpdatePlan,
): Promise<Stepped<string>> {
  if (plan.install) {
    const installed = await stepped("install", () =>
      commands.npm(["ci", "--ignore-scripts"]),
    );
    if (installed.kind === "failed") return installed;
  }
  return stepped("build", () => commands.npm(["run", "build"]));
}

function stoppedNote(plan: UpdatePlan): string {
  const steps = plan.install
    ? "npm ci --ignore-scripts and npm run build"
    : "npm run build";
  return `\nThe service stopped during the update. The checkout is back on ${plan.head}. Run ${steps} in the checkout before the next start.`;
}

function failedRollback(plan: UpdatePlan, output: string): string {
  return `\nThe rollback to ${plan.head} failed: ${output}`;
}

function stopped(commands: CheckoutCommands): boolean {
  return commands.stopping.aborted;
}

async function rollbackNote(
  commands: CheckoutCommands,
  plan: UpdatePlan,
): Promise<string> {
  const reset = await stepped("merge", () =>
    commands.git(["reset", "--keep", plan.head]),
  );
  if (reset.kind === "failed") return failedRollback(plan, reset.output);
  if (stopped(commands)) return stoppedNote(plan);
  const rebuilt = await built(commands, plan);
  if (rebuilt.kind === "done") return "";
  if (stopped(commands)) return stoppedNote(plan);
  return failedRollback(plan, rebuilt.output);
}

export async function updatedCheckout(
  commands: CheckoutCommands,
): Promise<CheckoutUpdate> {
  const plan = await updatePlan(commands.git);
  if (plan.kind !== "done") return plan;
  const { head, target } = plan.value;
  const merged = await stepped("merge", () =>
    commands.git(["merge", "--ff-only", "--no-overwrite-ignore", target]),
  );
  if (merged.kind === "failed") return merged;
  const done = await built(commands, plan.value);
  if (done.kind === "done") return { kind: "updated", from: head, to: target };
  const note = await rollbackNote(commands, plan.value);
  return failedAt(done.step, `${done.output}${note}`);
}

const commandLimits = { git: 120_000, npm: 1_800_000 } as const;

const steadyCommands = new Set(["git merge", "git reset"]);

export function checkoutCommands(settings: {
  readonly checkout: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly stopping: AbortSignal;
}): CheckoutCommands {
  const command =
    (file: "git" | "npm") =>
    async (argumentsList: readonly string[]): Promise<string> =>
      (
        await promisify(execFile)(file, argumentsList, {
          cwd: settings.checkout,
          env: settings.environment,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          timeout: commandLimits[file],
          ...(steadyCommands.has(`${file} ${argumentsList[0] ?? ""}`)
            ? {}
            : { signal: settings.stopping }),
        })
      ).stdout;
  return {
    git: command("git"),
    npm: command("npm"),
    stopping: settings.stopping,
  };
}
