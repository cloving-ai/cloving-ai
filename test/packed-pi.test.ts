import assert from "node:assert/strict";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  installPacked,
  packCheckoutCopy,
  packedCommand,
} from "./packed-install-fixture.ts";
import {
  startPackedHost,
  ready,
  stopPackedHost,
} from "./packed-host-fixture.ts";
import { stopChildGroup } from "./stop-child.ts";
import { withFiles } from "./quality/files-fixture.ts";
import {
  object,
  piCli,
  piConsumer,
  piRequests,
  waitPi,
} from "./packed-pi-fixture.ts";

async function start(root: string, env: NodeJS.ProcessEnv) {
  const host = startPackedHost({
    root,
    env,
    executable: join(root, "node_modules/.bin/cloving"),
  });
  try {
    const address = await ready(host.child, host.output);
    return { ...host, address };
  } catch (error) {
    await stopChildGroup(host.child);
    throw error;
  }
}

async function run(
  consumer: { root: string; env: NodeJS.ProcessEnv },
  prompt: string,
) {
  const { root, env } = consumer;
  const path = join(root, "input.json");
  await writeFile(path, JSON.stringify({ prompt }));
  const admitted = await piCli({ root, env }, [
    "run",
    "qualify-pi",
    "--input",
    path,
  ]);
  assert.equal(admitted["kind"], "run-admitted", JSON.stringify(admitted));
  return String(admitted["runId"]);
}

async function ended(
  consumer: { root: string; env: NodeJS.ProcessEnv },
  runId: string,
) {
  const { root, env } = consumer;
  return waitPi(async () => {
    const status = object(
      (await piCli({ root, env }, ["status", runId]))["run"],
    );
    return status["state"] === "completed" ? status : undefined;
  });
}

async function selection(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  const cli = join(root, "node_modules/.bin/cloving");
  const configure = (args: readonly string[]) =>
    packedCommand(cli, { args, cwd: root, env });
  configure(["config", "set", "harness.name", "pi", "--private"]);
  configure([
    "config",
    "set",
    "harness.command",
    JSON.stringify([
      join(root, "fake-pi.mjs"),
      "--mode",
      "json",
      "--provider",
      "fixture",
      "--model",
      "model",
      "--thinking",
      "low",
    ]),
    "--private",
  ]);
  configure([
    "config",
    "set",
    "profiles",
    JSON.stringify({ pi: { harness: "pi", model: "selected-model" } }),
    "--private",
  ]);
  configure([
    "config",
    "set",
    "tokenPrices",
    JSON.stringify({
      "fixture/model": { input: 2, cachedInput: 0.5, output: 8 },
    }),
    "--private",
  ]);
  const saved = await piCli({ root, env }, ["config", "get", "harness.name"]);
  assert.match(JSON.stringify(saved), /pi/);
  const guide = await readFile(
    join(root, "node_modules/cloving/README.md"),
    "utf8",
  );
  assert.ok(
    guide.includes("### Pi capability qualification"),
    "The shipped guide must qualify Pi capabilities",
  );
}

async function firstPrompt(
  consumer: { root: string; env: NodeJS.ProcessEnv },
  expected: { runId: string; prompt: string },
) {
  const { root, env } = consumer;
  const { runId, prompt } = expected;
  const first = await waitPi(async () => {
    const request = (await piRequests(root)).find(
      (entry) => entry["type"] === "prompt",
    );
    if (request !== undefined) return request;
    const status = object(
      (await piCli({ root, env }, ["status", runId]))["run"],
    );
    assert.notEqual(
      status["state"],
      "completed",
      JSON.stringify({ ...status, input: undefined }),
    );
    return undefined;
  });
  assert.equal(first["message"], prompt);
  assert.ok(Array.isArray(first["arguments"]));
  assert.ok(first["arguments"].includes("selected-model"));
  assert.ok(first["arguments"].includes("command-override-provider"));
  assert.ok(first["arguments"].includes("medium"));
  return first;
}

async function lifecycle(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  const host = await start(root, env);
  try {
    const prompt =
      " \n@literal $(touch forbidden) `false` 🐈\n" +
      "large input ".repeat(5000) +
      " \n";
    const runId = await run({ root, env }, prompt);
    const first = await firstPrompt({ root, env }, { runId, prompt });
    const restarted = await piCli({ root, env }, ["restart", "--at", "now"]);
    assert.match(JSON.stringify(restarted), /restarted/);
    process.kill(Number(first["processId"]), 0);
    const steered = await piCli({ root, env }, [
      "steer",
      runId,
      "--text",
      "Keep the existing work.",
      "--now",
    ]);
    assert.match(JSON.stringify(steered), /now/);
    await waitPi(async () =>
      (await piRequests(root)).find((request) => request["type"] === "steer"),
    );
    assert.equal(
      (await piRequests(root)).filter((request) => request["type"] === "prompt")
        .length,
      1,
    );
    const request = (await piRequests(root)).find(
      (entry) => entry["type"] === "steer",
    );
    assert.equal(request?.["processId"], first["processId"]);
    await writeFile(join(root, "release"), "settle");
    const status = await ended({ root, env }, runId);
    assert.equal(object(status["outcome"])["reason"], "completed");
    const address = [
      ...host.output.text.matchAll(
        /Watch page: (http:\/\/127\.0\.0\.1:\d+\/)/g,
      ),
    ].at(-1)?.[1];
    assert.ok(address);
    await completedTranscript({ root, env }, { status, address });
    await unlink(join(root, "release"));
    await failureAndDrop(root, env);
  } finally {
    await stopPackedHost(host);
  }
}

async function completedTranscript(
  consumer: { root: string; env: NodeJS.ProcessEnv },
  evidence: { status: Record<string, unknown>; address: string },
): Promise<void> {
  const { status, address } = evidence;
  const turns = status["workerTurns"];
  assert.ok(Array.isArray(turns));
  assert.equal(turns.length, 1);
  const turn = object(turns[0]);
  assert.equal(turn["harness"], "pi");
  assert.equal(turn["model"], "fixture/model");
  assert.equal(turn["costUsd"], null);
  assert.equal(turn["estimatedCostUsd"], 0.00038);
  assert.deepEqual(turn["usage"], {
    input_tokens: 100,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 0,
    output_tokens: 20,
  });
  const response = await fetch(
    address +
      `api/v1/runs/${String(status["runId"])}/turns/${encodeURIComponent(String(turn["operationId"]))}/transcript`,
  );
  assert.equal(response.status, 200);
  const transcript = object(await response.json());
  const entries = transcript["entries"];
  assert.ok(Array.isArray(entries));
  assert.ok(entries.some((entry) => object(entry)["kind"] === "prompt"));
  assert.ok(
    entries.some(
      (entry) =>
        object(entry)["text"] === "Packed Pi answer.\nTicket status: complete",
    ),
  );
  assert.match(JSON.stringify(status["notes"]), /Keep the existing work/);
  const shown = await piCli(consumer, ["status", String(status["runId"])]);
  assert.equal(object(shown["run"])["estimatedCostUsd"], 0.00038);
}

async function failureAndDrop(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const oversized = await run({ root, env }, "large input ".repeat(7000));
  const refused = await ended({ root, env }, oversized);
  assert.equal(object(refused["outcome"])["reason"], "input-too-large");
  const failed = await run({ root, env }, "FAIL_WITHOUT_CREDENTIALS");
  const status = await ended({ root, env }, failed);
  assert.equal(object(status["outcome"])["kind"], "blocked");
  assert.match(JSON.stringify(status["effects"]), /failed/);
  assert.equal(status["claudeCostUsd"], null);
  assert.equal(status["estimatedCostUsd"], null);
  assert.equal(status["costDisplay"], "Price not known");
  const runId = await run({ root, env }, "Hold until dropped");
  const prompt = await waitPi(async () =>
    (await piRequests(root)).find(
      (request) => request["message"] === "Hold until dropped",
    ),
  );
  const questions = await piCli({ root, env }, ["questions"]);
  assert.deepEqual(questions["decisions"], []);
  const current = object(
    (await piCli({ root, env }, ["status", runId]))["run"],
  );
  await piCli({ root, env }, [
    "drop",
    runId,
    "--expected-revision",
    String(current["revision"]),
  ]);
  await waitPi(() => {
    try {
      process.kill(Number(prompt["processId"]), 0);
      return undefined;
    } catch {
      return true;
    }
  });
  const requests = await piRequests(root);
  assert.equal(
    requests.filter((request) => request["type"] === "prompt").length,
    3,
  );
  assert.equal(
    requests.some((request) => request["type"] === "extension_ui_response"),
    false,
  );
}

await test("CLV-366 the packed Pi service selects, steers, restarts, fails and drops without provider calls", async () => {
  await withFiles({}, async (root) => {
    const archive = await packCheckoutCopy(
      resolve(import.meta.dirname, ".."),
      root,
    );
    assert.deepEqual(
      archive.paths.filter((path) =>
        /(?:^|\/)(?:pi|auth\.json|sessions|ticket-work|journal)(?:\/|$)/.test(
          path,
        ),
      ),
      [],
    );
    await installPacked(root, {
      archive: join(root, archive.filename),
      checkout: resolve(import.meta.dirname, ".."),
    });
    packedCommand("git", { args: ["init", "-q"], cwd: root });
    packedCommand("git", {
      args: [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-qm",
        "Fixture",
      ],
      cwd: root,
    });
    await mkdir(join(root, "config"));
    const env = await piConsumer(root);
    await selection(root, env);
    await lifecycle(root, env);
  });
});
