import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { withFiles } from "./quality/files-fixture.ts";

export const auditScript =
  "templates/dependency-audit/dependency-audit/audit-candidates.mts";

export interface FakeAudit {
  readonly audit: unknown;
  readonly tree: unknown;
  readonly issues: unknown;
  readonly failures?: Readonly<Record<string, string>>;
}

export interface LoggedCall {
  readonly command: string;
  readonly cwd: string;
  readonly lock: string | null;
  readonly status: string;
}

const fakeCommand = `#!/usr/bin/env -S -u NODE_V8_COVERAGE ${process.execPath}
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { spawnSync } from "node:child_process";
const state = JSON.parse(readFileSync(process.env.FAKE_AUDIT_STATE, "utf8"));
const command = [basename(process.argv[1]), ...process.argv.slice(2)].join(" ");
const status = spawnSync("git", ["status", "--porcelain", "--branch"], { encoding: "utf8" }).stdout;
const lock = existsSync("package-lock.json") ? readFileSync("package-lock.json", "utf8") : null;
appendFileSync(process.env.FAKE_AUDIT_LOG, JSON.stringify({ command, cwd: process.cwd(), lock, status }) + "\\n");
const outputs = {
  "npm ci --ignore-scripts --no-audit --no-fund": ["", 0],
  "npm audit --json": [JSON.stringify(state.audit), 1],
  "npm ls --all --json": [JSON.stringify(state.tree), 0],
  "gh api --paginate --slurp repos/{owner}/{repo}/issues?state=open&labels=cloving%3A%20security&per_page=100": [JSON.stringify(state.issues), 0],
};
const failure = state.failures?.[command];
const [stdout, code] = failure === undefined ? outputs[command] ?? ["", 2] : ["", 1];
process.stdout.write(stdout);
process.stderr.write(failure === undefined ? "" : failure + "\\n");
process.exitCode = code;
`;

function git(directory: string, args: readonly string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      env: Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: "/dev/null" }),
    },
  );
}

async function commitLock(directory: string, lock: string): Promise<void> {
  await writeFile(join(directory, "package-lock.json"), lock);
  git(directory, ["add", "package-lock.json"]);
  git(directory, ["commit", "--quiet", "-m", lock]);
  git(directory, ["push", "--quiet", "origin", "HEAD:main"]);
}

export interface AuditPlace {
  readonly root: string;
  readonly repository: string;
  readonly temporary: string;
}

export function withAuditRepository<Result>(
  state: FakeAudit,
  inspect: (place: AuditPlace) => Promise<Result> | Result,
): Promise<Result> {
  return withFiles({ "bin/.keep": "", "tmp/.keep": "" }, async (root) => {
    git(root, [
      "init",
      "--quiet",
      "--bare",
      "--initial-branch=main",
      "origin.git",
    ]);
    git(root, ["clone", "--quiet", "origin.git", "seed"]);
    await commitLock(join(root, "seed"), "stale lock\n");
    git(root, ["clone", "--quiet", "origin.git", "repository"]);
    await commitLock(join(root, "seed"), "newest lock\n");
    for (const name of ["npm", "gh"]) {
      await writeFile(join(root, "bin", name), fakeCommand);
      await chmod(join(root, "bin", name), 0o755);
    }
    await writeFile(join(root, "state.json"), JSON.stringify(state));
    await mkdir(join(root, "tmp", "audit"));
    return await inspect({
      root,
      repository: join(root, "repository"),
      temporary: join(root, "tmp", "audit"),
    });
  });
}

export function runAudit(place: AuditPlace): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "..", auditScript)],
    {
      cwd: place.repository,
      encoding: "utf8",
      env: Object.assign({}, process.env, {
        PATH: `${join(place.root, "bin")}${delimiter}${process.env["PATH"] ?? ""}`,
        TMPDIR: place.temporary,
        GIT_CONFIG_GLOBAL: "/dev/null",
        FAKE_AUDIT_STATE: join(place.root, "state.json"),
        FAKE_AUDIT_LOG: join(place.root, "calls.log"),
      }),
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function loggedCalls(
  place: AuditPlace,
): Promise<readonly LoggedCall[]> {
  const text = await readFile(join(place.root, "calls.log"), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line): LoggedCall => {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null)
        throw new Error("invalid log line");
      return Object.assign(
        { command: "", cwd: "", lock: null, status: "" },
        value,
      );
    });
}

export function worktrees(place: AuditPlace): readonly string[] {
  return git(place.repository, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
}
