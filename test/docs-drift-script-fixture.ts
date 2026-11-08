import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { withFiles } from "./quality/files-fixture.ts";
import { startCommand } from "../src/daemon/command-process.ts";

const scriptFolder = "templates/docs-drift/docs-drift";

export const seedFiles: Readonly<Record<string, string>> = {
  "README.md":
    "# Demo\n\nSet `queue.seconds` to change the wait. The default is 30.\n",
  "AGENTS.md": "Run `npm test` before a commit.\n",
  "templates/x/README.md": "The script x/run.mts prints `invalid-input`.\n",
  "src/settings.ts": "export const queueSeconds = 60; // queue.seconds\n",
  "templates/x/x/run.mts": 'throw new Error("invalid-input");\n',
  "notes.txt": "Plain notes of the operator.\n",
};

const fakeGh = `#!/usr/bin/env -S -u NODE_V8_COVERAGE ${process.execPath}
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const github = process.env.GH_CONFIG_DIR ?? "";
const command = ["gh", ...process.argv.slice(2)].join(" ");
appendFileSync(process.env.FAKE_DOCS_LOG, JSON.stringify({ command, cwd: process.cwd(), github }) + "\\n");
if (!existsSync(join(github, "hosts.yml"))) {
  process.stderr.write("You are not logged into any GitHub hosts. To log in, run: gh auth login\\n");
  process.exitCode = 1;
} else {
  process.stdout.write(readFileSync(process.env.FAKE_DOCS_ISSUES, "utf8"));
}
`;

export function git(directory: string, args: readonly string[]): string {
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

export interface DocsPlace {
  readonly root: string;
  readonly repository: string;
  readonly login: string;
  readonly record: string;
  readonly command: string;
}

export async function pushSeed(
  place: DocsPlace,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const seed = join(place.root, "seed");
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(seed, path)), { recursive: true });
    await writeFile(join(seed, path), text);
  }
  git(seed, ["add", "--all"]);
  git(seed, ["commit", "--quiet", "--allow-empty", "-m", "change"]);
  git(seed, ["push", "--quiet", "origin", "HEAD:main"]);
  return git(seed, ["rev-parse", "HEAD"]).trim();
}

export function withDocsRepository<Result>(
  issues: unknown,
  inspect: (place: DocsPlace) => Promise<Result> | Result,
): Promise<Result> {
  const files = {
    "bin/.keep": "",
    "login/hosts.yml": "github.com:\n  user: operator\n",
    "command/.keep": "",
    "state/.keep": "",
    "issues.json": JSON.stringify(issues),
  };
  return withFiles(files, async (root) => {
    git(root, [
      "init",
      "--quiet",
      "--bare",
      "--initial-branch=main",
      "origin.git",
    ]);
    git(root, ["clone", "--quiet", "origin.git", "seed"]);
    const place = {
      root,
      repository: join(root, "repository"),
      login: join(root, "login"),
      record: join(root, "state", "docs-record.json"),
      command: join(root, "command"),
    };
    await pushSeed(place, { "first.txt": "first\n" });
    git(root, ["clone", "--quiet", "origin.git", "repository"]);
    await pushSeed(place, seedFiles);
    await writeFile(join(root, "bin", "gh"), fakeGh);
    await chmod(join(root, "bin", "gh"), 0o755);
    return await inspect(place);
  });
}

export interface ScriptEnd {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runScript(
  place: DocsPlace,
  run: {
    readonly script: "docs-candidates.mts" | "docs-drift-record.mts";
    readonly args: readonly string[];
    readonly payload?: string;
  },
): Promise<ScriptEnd> {
  const ended = await startCommand({
    command: [
      "/usr/bin/env",
      `PATH=${join(place.root, "bin")}${delimiter}${process.env["PATH"] ?? ""}`,
      "GIT_CONFIG_GLOBAL=/dev/null",
      `FAKE_DOCS_LOG=${join(place.root, "calls.log")}`,
      `FAKE_DOCS_ISSUES=${join(place.root, "issues.json")}`,
      process.execPath,
      join(import.meta.dirname, "..", scriptFolder, run.script),
      ...run.args,
    ],
    directory: place.repository,
    folder: place.command,
    payload: run.payload ?? "{}",
    runId: "run-1",
    operationId: "operation-1",
    seconds: 120,
  }).ended;
  return {
    status: ended.exitCode,
    stdout: ended.stdout,
    stderr: await readFile(join(place.command, "command.stderr.log"), "utf8"),
  };
}

export async function ghCalls(
  place: DocsPlace,
): Promise<readonly { readonly command: string; readonly github: string }[]> {
  const text = await readFile(join(place.root, "calls.log"), "utf8").catch(
    () => "",
  );
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const value: unknown = JSON.parse(line);
      return Object.assign({ command: "", github: "" }, value);
    });
}
