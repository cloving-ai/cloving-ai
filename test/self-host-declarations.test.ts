import { stopChildGroup } from "./stop-child.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ended, field, reached } from "./self-host-fixture.ts";
import { call, parsed, runCli } from "./service-fixture.ts";
import { watchReader } from "../src/cli/watch-reads.ts";
import { boardModel } from "./watch-board-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

const declaration = {
  workflowId: "review-run",
  effectLimit: 14,
  capabilities: ["claude"],
  stages: [{ name: "draft", label: "Draft", gateIds: ["write-draft"] }],
  input: {
    maximumBytes: 65_536,
    fields: {
      prompt: { type: "string" },
      rounds: { type: "integer", minimum: 1, maximum: 10, optional: true },
      publish: { type: "boolean", optional: true },
    },
  },
};

function launch(root: string): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      resolve("tools/self-host.ts"),
      "--runtime",
      join(root, "host/run"),
      "--repository",
      root,
    ],
    {
      env: {
        ...process.env,
        CLOVING_WATCH_PORT: "off",
        CLOVING_PHONE_RELAY: "off",
        CLOVING_WORKER: "claude",
        CLOVING_CLAUDE_COMMAND: '["true"]',
        CLOVING_QUEUE_SECONDS: undefined,
        CLOVING_QUEUE_LANES: undefined,
        CLOVING_SELF_UPDATE_SECONDS: undefined,
        CLOVING_PROFILES: undefined,
        XDG_CONFIG_HOME: join(root, "configuration"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  return child;
}

async function checkListing(root: string): Promise<void> {
  const runtimeDirectory = join(root, "host/run");
  const listed = await call(
    { runtimeDirectory },
    { operation: "status", parameters: {} },
  );
  assert.deepEqual(listed["workflows"], ["review-run"], JSON.stringify(listed));
  assert.deepEqual(listed["workflowStages"], {
    "review-run": declaration.stages,
  });
}

async function checkRun(root: string): Promise<void> {
  const runtimeDirectory = join(root, "host/run");
  const environment = { directory: root, runtime: runtimeDirectory };
  const cli = (args: readonly string[]) => runCli(args, environment);
  const status = await cli(["status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /review-run/);
  await writeFile(
    join(root, "input.json"),
    JSON.stringify({ prompt: "Check the change.", rounds: 0 }),
  );
  const invalid = await cli([
    "run",
    "review-run",
    "--input",
    "input.json",
    "--json",
  ]);
  assert.notEqual(invalid.status, 0);
  assert.equal(parsed(invalid)["code"], "invalid-submission");
  assert.equal(parsed(invalid)["detail"], "Field rounds is not valid.");
  assert.deepEqual(
    (await call({ runtimeDirectory }, { operation: "status", parameters: {} }))[
      "runs"
    ],
    [],
  );
  const input = { prompt: "Check the change.", rounds: 3, publish: false };
  await writeFile(join(root, "input.json"), JSON.stringify(input));
  const valid = await cli([
    "run",
    "review-run",
    "--input",
    "input.json",
    "--command-id",
    "command-1",
    "--json",
  ]);
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  const run = await reached(async () => {
    const shown = await call(
      { runtimeDirectory },
      { operation: "status", parameters: { runId: parsed(valid)["runId"] } },
    );
    return field(shown["run"], "state") === "completed"
      ? shown["run"]
      : undefined;
  });
  assert.deepEqual(field(run, "budget"), { limit: 14, spent: 0 });
  assert.deepEqual(field(run, "outcome"), {
    kind: "handoff_requested",
    reason: null,
  });
}

async function withDaemon(
  child: ChildProcess,
  body: () => Promise<void>,
): Promise<void> {
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (bytes: Buffer) => {
      output += bytes.toString();
    });
  try {
    await reached(() => {
      if (child.exitCode !== null) throw new Error(output);
      return Promise.resolve(
        output.includes("Cloving runs") ? true : undefined,
      );
    });
    await body();
    assert.equal(await ended(child), 0);
  } finally {
    await stopChildGroup(child);
  }
}

async function readBoards(root: string, now: string) {
  const read = await watchReader(join(root, "host/run")).read(now);
  return boardModel(read.runs, { ...read, updatedAt: now }).workflows;
}

await test("CLV-089 start registers a sidecar workflow and run delivers checked typed input to its compiled function", async () => {
  await withFiles(
    {
      ".cloving/workflows/review-run.ts":
        'export async function __proto__(input: unknown) {\n  "use workflow";\n  return { kind: "blocked", reason: JSON.stringify(input) };\n}',
      ".cloving/workflows/review-run.declaration.json": JSON.stringify({
        workflow: declaration,
        methods: { claude: ["run-turn"] },
      }),
    },
    async (root) => {
      const expected = {
        cycleId: "task-e12c157c0051",
        repository: root,
        input: { prompt: "Check the change.", rounds: 3, publish: false },
      };
      await writeFile(
        join(root, ".cloving/workflows/review-run.ts"),
        `import { sleep } from "cloving/workflows/steps/sleep";
export async function __proto__(input: unknown) {
  "use workflow";
  await sleep({ seconds: 1 });
  return { kind: JSON.stringify(input) === ${JSON.stringify(JSON.stringify(expected))} ? "handoff_requested" : "blocked" };
}`,
      );
      let now = "";
      let before: Awaited<ReturnType<typeof readBoards>> = [];
      await withDaemon(launch(root), async () => {
        await checkListing(root);
        await checkRun(root);
        now = new Date().toISOString();
        before = await readBoards(root, now);
        const board = before.find((item) => item.workflowId === "review-run");
        assert.deepEqual(
          board?.columns.map((column) => column.name),
          ["Draft", "Other", "Done", "Stopped"],
        );
        assert.equal(board.columns[2]?.cards.length, 1);
        await writeFile(
          join(root, ".cloving/workflows/review-run.declaration.json"),
          "{}",
        );
        assert.deepEqual(await readBoards(root, now), before);
        await writeFile(
          join(root, ".cloving/workflows/review-run.declaration.json"),
          JSON.stringify({
            workflow: declaration,
            methods: { claude: ["run-turn"] },
          }),
        );
      });
      await withDaemon(launch(root), async () => {
        assert.deepEqual(await readBoards(root, now), before);
      });
    },
  );
});
