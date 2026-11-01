import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { record } from "../src/protocol.ts";
import { configuration } from "../src/configuration-schema.ts";
import { parseCommandSeconds } from "../src/command-settings.ts";
import { redGreenProcess, type RunResult } from "./red-green-process.ts";

function git(argumentsList: readonly string[]): string {
  return execFileSync("git", [...argumentsList], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function run(input: {
  readonly revision: string;
  readonly head: string;
  readonly files: readonly string[];
  readonly test: readonly string[];
  readonly prepare: readonly string[] | undefined;
  readonly signal: AbortSignal;
  readonly milliseconds: number;
}): Promise<RunResult> {
  const temporary = mkdtempSync(join(tmpdir(), "cloving-red-green-"));
  const tree = join(temporary, "tree");
  try {
    git(["worktree", "add", "--detach", tree, input.revision]);
    if (input.revision !== input.head)
      git([
        "--literal-pathspecs",
        "-C",
        tree,
        "restore",
        "--source",
        input.head,
        "--worktree",
        "--",
        ...input.files,
      ]);
    const options = {
      directory: tree,
      signal: input.signal,
      milliseconds: input.milliseconds,
    };
    const prepared =
      input.prepare === undefined
        ? undefined
        : await redGreenProcess(input.prepare, options);
    if (prepared !== undefined && prepared.status !== 0)
      return { ...prepared, prepareFailed: true };
    const tested = await redGreenProcess(
      [...input.test, ...input.files],
      options,
    );
    return { ...tested, output: (prepared?.output ?? "") + tested.output };
  } finally {
    git(["worktree", "remove", "--force", tree]);
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function redGreenCommand(signal: AbortSignal): Promise<void> {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(
      'Usage: cloving red-green\n\nReads {"head":"<full commit ID>"} on standard input.\nCLOVING_RED_GREEN configures test, testFiles, prepare, assertionPattern and skipPattern.\nPrints one JSON verdict from temporary detached worktrees.\n',
    );
    return;
  }
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  const head = inputHead(text);
  const { settings, assertion, skip } = redGreenSettings();
  const { test, testFiles: prefixes, prepare } = settings;
  if (git(["cat-file", "-t", head]).trim() !== "commit")
    throw new Error("invalid-red-green-input: head must be a full commit ID");
  if (git(["rev-parse", "--verify", head]).trim() !== head.toLowerCase())
    throw new Error("invalid-red-green-input: head must be a full commit ID");
  const base = git(["merge-base", head, "refs/remotes/origin/HEAD"]).trim();
  const files = changedTests({ base, head, prefixes });
  if (files.length === 0) {
    process.stdout.write(
      JSON.stringify({
        verdict: "no-test-change",
        base,
        head,
        files,
        output: "",
      }) + "\n",
    );
    return;
  }
  const milliseconds =
    parseCommandSeconds(process.env["CLOVING_COMMAND_SECONDS"]) * 1000;
  const options = { head, files, test, prepare, signal, milliseconds };
  const red = await run({ ...options, revision: base });
  signal.throwIfAborted();
  const green = await run({ ...options, revision: head });
  signal.throwIfAborted();
  const result = classify({ red, green, assertion, skip });
  process.stdout.write(
    JSON.stringify({
      ...result,
      output: result.output.slice(-16000),
      base,
      head,
      files,
    }) + "\n",
  );
}

function changedTests(input: {
  readonly base: string;
  readonly head: string;
  readonly prefixes: readonly string[];
}): string[] {
  return git([
    "diff",
    "--no-renames",
    "--name-only",
    "--diff-filter=AMT",
    "-z",
    input.base,
    input.head,
  ])
    .split("\0")
    .filter((file) => input.prefixes.some((prefix) => file.startsWith(prefix)));
}

function classify(input: {
  readonly red: RunResult;
  readonly green: RunResult;
  readonly assertion: RegExp;
  readonly skip: RegExp;
}) {
  const { red, green, assertion, skip } = input;
  for (const result of [red, green])
    if (result.prepareFailed === true)
      return { verdict: "prepare-failed", output: result.output };
  for (const result of [red, green])
    if (skip.test(result.output))
      return { verdict: "skipped-test", output: result.output };
  if (red.status === 0) return { verdict: "false-red", output: red.output };
  if (!assertion.test(red.output))
    return { verdict: "red-not-assertion", output: red.output };
  if (green.status !== 0)
    return { verdict: "green-failed", output: green.output };
  return { verdict: "accepted", output: green.output };
}

function inputHead(text: string): string {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error(
      "invalid-red-green-input: expected JSON with a full commit ID in head",
    );
  }
  const head = record(input)?.["head"];
  if (
    typeof head !== "string" ||
    !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(head)
  )
    throw new Error("invalid-red-green-input: head must be a full commit ID");
  return head;
}

function redGreenSettings() {
  try {
    const value: unknown = JSON.parse(
      process.env["CLOVING_RED_GREEN"] ?? "null",
    );
    const settings = configuration(
      { version: 1, checks: { redGreen: value } },
      "project",
    ).checks?.redGreen;
    if (settings === undefined) throw new Error("missing settings");
    return {
      settings,
      assertion: new RegExp(settings.assertionPattern ?? "ERR_ASSERTION"),
      skip: new RegExp(settings.skipPattern ?? "# SKIP\\b"),
    };
  } catch (error) {
    throw new Error(
      "invalid-CLOVING_RED_GREEN: " +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
}

const controller = new AbortController();
const interrupt = (): void => {
  controller.abort();
};
process.on("SIGTERM", interrupt);
process.on("SIGINT", interrupt);
try {
  await redGreenCommand(controller.signal);
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : String(error)) + "\n",
  );
  process.exitCode = 1;
} finally {
  process.off("SIGTERM", interrupt);
  process.off("SIGINT", interrupt);
}
