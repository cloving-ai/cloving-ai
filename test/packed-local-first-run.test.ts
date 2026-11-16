import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  installPacked,
  packCheckoutCopy,
  packedCommand,
} from "./packed-install-fixture.ts";
import {
  ready,
  startPackedHost,
  stopPackedHost,
} from "./packed-host-fixture.ts";
import { object, piCli as cli, waitPi as reach } from "./packed-pi-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { stopChildGroup } from "./stop-child.ts";

interface Consumer {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
}

const prompt = "Add a test for the date parser";

const fakeClaude = `
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
if (process.argv[2] === "--version") { console.log("1.0.0 (Claude Code)"); process.exit(0); }
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(new URL("claude-prompts.jsonl", import.meta.url), JSON.stringify(prompt) + "\\n");
writeFileSync("date-parser.txt", "A test for the date parser.\\n");
execFileSync("git", ["add", "date-parser.txt"]);
execFileSync("git", ["-c", "user.name=Worker", "-c", "user.email=worker@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Add a date parser test"]);
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
line({ type: "system", subtype: "init", session_id: "session-1" });
line({ type: "result", subtype: "success", is_error: false, result: "I added the test.\\nTicket status: complete", total_cost_usd: 0.01, session_id: "session-1", num_turns: 1 });
`;

const recordingGitHub = `
import { appendFileSync } from "node:fs";
appendFileSync(new URL("github-calls.jsonl", import.meta.url), JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(1);
`;

async function program(
  root: string,
  input: { readonly name: string; readonly body: string },
): Promise<string> {
  const path = join(root, "bin", input.name);
  await writeFile(path, `#!${process.execPath}\n${input.body}`, {
    mode: 0o700,
  });
  return path;
}

async function localConsumer(root: string): Promise<Consumer> {
  await mkdir(join(root, "bin"));
  const github = await program(root, {
    name: "gh",
    body: recordingGitHub,
  });
  const env = {
    PATH: `${join(root, "bin")}:${process.env["PATH"] ?? ""}`,
    HOME: root,
    SHELL: "/bin/zsh",
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    CLOVING_RUNTIME_DIR: join(root, "host/run"),
    CLOVING_WATCH_PORT: "0",
    CLOVING_NEXT_COMMAND: "[]",
    CLOVING_TICKET_COMMAND: "[]",
    CLOVING_CHECK_COMMAND: "[]",
    CLOVING_GH_COMMAND: JSON.stringify([github]),
    NODE_OPTIONS: "--no-strip-types",
  };
  const git = (args: readonly string[]) =>
    packedCommand("git", { args, cwd: root, env });
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  git(["add", ".gitignore"]);
  git([
    "-c",
    "user.name=Owner",
    "-c",
    "user.email=owner@example.invalid",
    "commit",
    "-qm",
    "Start the project",
  ]);
  return { root, env };
}

async function initialized(consumer: Consumer): Promise<void> {
  const { root, env } = consumer;
  const harness = await program(root, { name: "claude", body: fakeClaude });
  const output = packedCommand(join(root, "node_modules/.bin/cloving"), {
    args: ["init", "--local", "--harness", harness],
    cwd: root,
    env,
  });
  assert.match(output, /Copied develop for one local task/);
}

async function started(consumer: Consumer) {
  const host = startPackedHost({
    ...consumer,
    executable: join(consumer.root, "node_modules/.bin/cloving"),
  });
  try {
    await ready(host.child, host.output);
    return host;
  } catch (error) {
    await stopChildGroup(host.child);
    throw error;
  }
}

async function reviewed(consumer: Consumer, runId: string) {
  const decision = await reach(async () => {
    const listed = await cli(consumer, ["questions", runId]);
    const decisions = listed["decisions"];
    return Array.isArray(decisions) ? decisions.map(object)[0] : undefined;
  });
  assert.equal(decision["type"], "approval");
  const approved = await cli(consumer, [
    "approve",
    String(decision["decisionId"]),
    "--expected-revision",
    String(decision["revision"]),
    "--generation",
    String(decision["generation"]),
    "--subject-digest",
    String(decision["subjectDigest"]),
  ]);
  assert.notEqual(approved["kind"], "error", JSON.stringify(approved));
}

async function completed(consumer: Consumer, runId: string) {
  return reach(async () => {
    const run = object((await cli(consumer, ["status", runId]))["run"]);
    return run["state"] === "completed" ? run : undefined;
  });
}

async function firstRun(consumer: Consumer): Promise<Record<string, unknown>> {
  const admitted = await cli(consumer, ["run", "develop", "--prompt", prompt]);
  assert.equal(admitted["kind"], "run-admitted", JSON.stringify(admitted));
  const runId = String(admitted["runId"]);
  await reviewed(consumer, runId);
  return completed(consumer, runId);
}

async function assertManualService(consumer: Consumer): Promise<void> {
  const service = await cli(consumer, ["status"]);
  assert.deepEqual(service["queues"], []);
  assert.deepEqual(service["workflows"], ["develop"]);
  assert.deepEqual(service["workflowRefusals"], []);
}

function localCommit(run: Record<string, unknown>): string {
  const outcome = object(run["outcome"]);
  assert.equal(outcome["kind"], "handoff_requested");
  assert.equal(outcome["ticketStatus"], "complete");
  const promotion = /^local-([0-9a-f]{40})$/.exec(
    String(outcome["promotionId"]),
  );
  assert.ok(promotion?.[1], String(outcome["promotionId"]));
  assert.deepEqual(run["budget"], { limit: 87, spent: 1 });
  const effects = run["effects"];
  assert.ok(Array.isArray(effects));
  assert.deepEqual(
    effects.map((effect) => object(effect)["state"]),
    ["completed"],
  );
  const turns = run["workerTurns"];
  assert.ok(Array.isArray(turns));
  assert.deepEqual(
    turns.map((turn) => object(turn)["harness"]),
    ["claude"],
  );
  const decisions = run["decisions"];
  assert.ok(Array.isArray(decisions));
  assert.deepEqual(
    decisions.map((decision) => [
      object(decision)["decision"],
      object(decision)["actor"],
    ]),
    [["approved", "local"]],
  );
  return promotion[1];
}

async function assertLocalHandoff(
  consumer: Consumer,
  run: Record<string, unknown>,
): Promise<void> {
  const commit = localCommit(run);
  const git = (args: readonly string[]) =>
    packedCommand("git", { args, cwd: consumer.root, env: consumer.env });
  assert.equal(git(["cat-file", "-t", commit]), "commit\n");
  assert.equal(git(["log", "--format=%s", "main"]), "Start the project\n");
  const prompts = (
    await readFile(join(consumer.root, "bin/claude-prompts.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
  assert.equal(prompts.length, 1);
  assert.match(String(prompts[0]), new RegExp(prompt));
  await assert.rejects(
    readFile(join(consumer.root, "bin/github-calls.jsonl")),
    { code: "ENOENT" },
  );
}

await test("#820 an installed package runs a fresh local init through start, an explicit prompt, person review and a local handoff", () =>
  withFiles({}, async (root) => {
    const checkout = resolve(import.meta.dirname, "..");
    const archive = await packCheckoutCopy(checkout, root);
    await installPacked(root, {
      archive: join(root, archive.filename),
      checkout,
    });
    const consumer = await localConsumer(root);
    await initialized(consumer);
    const host = await started(consumer);
    try {
      await assertManualService(consumer);
      await assertLocalHandoff(consumer, await firstRun(consumer));
    } finally {
      await stopPackedHost(host);
    }
  }));
