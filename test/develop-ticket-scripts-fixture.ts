import { spawnSync } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { withFiles } from "./quality/files-fixture.ts";

export interface FakeIssue {
  readonly number: number;
  readonly state: "open" | "closed";
  readonly createdAt: string;
  readonly closedAt?: string;
  readonly labels?: readonly string[];
  readonly body?: string;
  readonly pullRequest?: true;
}

export interface FakeGithub {
  readonly issues: readonly FakeIssue[];
  readonly failure?: {
    readonly command: "list" | "api";
    readonly stderr: string;
  };
  readonly listOutput?: string;
  readonly apiOutput?: string;
}

const fakeGh = `#!/usr/bin/env -S -u NODE_V8_COVERAGE ${process.execPath}
import { readFileSync } from "node:fs";
const github = JSON.parse(readFileSync(process.env.FAKE_GH_STATE, "utf8"));
const args = process.argv.slice(2);
const listing = ["api", "--paginate", "--slurp", "repos/{owner}/{repo}/issues?state=open&labels=cloving%3A%20ready&per_page=100"];
const reading = /^repos\\/\\{owner\\}\\/\\{repo\\}\\/issues\\/([1-9][0-9]*)$/.exec(args[1] ?? "");
const command = JSON.stringify(args) === JSON.stringify(listing) ? "list" : args[0] === "api" && args.length === 2 && reading ? "api" : undefined;
const issue = github.issues.find((item) => item.number === Number(reading?.[1]));
const answer = () => {
  if (command === undefined) return { code: 2, stderr: "unexpected arguments: " + JSON.stringify(args) + "\\n" };
  if (github.failure?.command === command) return { code: 1, stderr: github.failure.stderr + "\\n" };
  if (command === "list" && github.listOutput !== undefined) return { stdout: github.listOutput };
  if (command === "list") {
    const rows = github.issues
      .filter((item) => item.state === "open" && (item.labels ?? []).includes("cloving: ready"))
      .toSorted((left, right) => right.number - left.number)
      .map((item) => ({ number: item.number, state: item.state, created_at: item.createdAt, body: item.body ?? null, ...(item.pullRequest ? { pull_request: { merged_at: null } } : {}) }));
    const pages = Array.from({ length: Math.max(1, Math.ceil(rows.length / 100)) }, (_, page) => rows.slice(page * 100, page * 100 + 100));
    return { stdout: JSON.stringify(pages) + "\\n" };
  }
  if (github.apiOutput !== undefined) return { stdout: github.apiOutput };
  if (issue === undefined) return { code: 1, stdout: JSON.stringify({ message: "Not Found", status: "404" }), stderr: "gh: Not Found (HTTP 404)\\n" };
  return { stdout: JSON.stringify({ number: issue.number, state: issue.state, created_at: issue.createdAt, closed_at: issue.closedAt ?? null, body: issue.body ?? null }) };
};
const { code = 0, stdout = "", stderr = "" } = answer();
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = code;
`;

export interface ScriptResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly warnings: readonly string[];
}

export function warningLines(stderr: string): readonly string[] {
  return stderr
    .split("\n")
    .filter(
      (line) => line !== "" && !/^\(node:\d+\)|--trace-warnings/.test(line),
    );
}

export function runScript(
  script: string,
  context: {
    readonly directory: string;
    readonly environment?: Readonly<Record<string, string>>;
  },
): ScriptResult {
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLOVING_SKIP_TICKETS: "",
      ...context.environment,
      PATH: `${join(context.directory, "bin")}${delimiter}${process.env["PATH"] ?? ""}`,
      FAKE_GH_STATE: join(context.directory, "github.json"),
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    warnings: warningLines(result.stderr),
  };
}

export async function writeFakeGithub(
  directory: string,
  github: FakeGithub,
): Promise<void> {
  await writeFile(join(directory, "github.json"), JSON.stringify(github));
  await writeFile(join(directory, "bin/gh"), fakeGh);
  await chmod(join(directory, "bin/gh"), 0o755);
}

export function withFakeGithub<Result>(
  github: FakeGithub,
  inspect: (directory: string) => Promise<Result> | Result,
): Promise<Result> {
  return withFiles({ "bin/.gitkeep": "" }, async (directory) => {
    await writeFakeGithub(directory, github);
    return await inspect(directory);
  });
}

export const nextTicketScript = "templates/develop/develop/next-ticket.mts";
export const readyTicketsScript = "templates/develop/develop/ready-tickets.mts";

export function readyIssue(
  number: number,
  fields: { readonly createdAt: string; readonly body?: string },
): FakeIssue {
  return {
    number,
    state: "open",
    labels: ["cloving: ready"],
    ...fields,
  };
}
