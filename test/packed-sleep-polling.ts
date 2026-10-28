import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  pollingDeclaration,
  pollingWorkflow,
} from "./command-polling-fixture.ts";
import { call } from "./service-fixture.ts";
import { field, items, reached } from "./self-host-fixture.ts";
import { stopChildGroup } from "./stop-child.ts";
import { startPackedHost, ready, boundedExit } from "./packed-host-fixture.ts";

export async function packedPollingFiles(root: string): Promise<void> {
  const base = join(root, ".cloving/workflows/polling");
  await writeFile(
    `${base}.ts`,
    pollingWorkflow.replace(
      'import { runCommand, sleep } from "cloving/workflows";',
      'import { runCommand } from "cloving/workflows";\nimport { sleep } from "cloving/workflows/steps/sleep";',
    ),
  );
  await writeFile(
    `${base}.declaration.json`,
    JSON.stringify(pollingDeclaration),
  );
  await writeFile(
    join(root, "approval-status.cjs"),
    `const fs = require("node:fs");
const file = "packed-polling-calls";
const calls = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\\n").filter(Boolean) : [];
fs.appendFileSync(file, process.env.CLOVING_OPERATION_ID + "\\n");
process.stdout.write(JSON.stringify({ ready: calls.length > 0 }));
`,
  );
  await writeFile(
    join(root, "polling-clock.mjs"),
    'import { mock } from "node:test"; mock.timers.enable({ apis: ["Date"], now: Number(process.env.CLOVING_PACKED_NOW) });',
  );
  await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import assert from "node:assert/strict"; import { sleep } from "cloving/workflows"; import { sleep as pause } from "cloving/workflows/steps/sleep"; assert.equal(typeof sleep, "function"); assert.equal(sleep, pause);',
    ],
    { cwd: root },
  );
}

interface Checkpoint {
  readonly runId: string;
  readonly sdkId: string;
  readonly waitId: string;
  readonly resumeAt: string;
}

async function records(directory: string): Promise<readonly unknown[]> {
  const files = (await readdir(directory)).filter((name) =>
    name.endsWith(".json"),
  );
  return await Promise.all(
    files.map(async (name) => {
      const value: unknown = JSON.parse(
        await readFile(join(directory, name), "utf8"),
      );
      return value;
    }),
  );
}

async function sdkRun(root: string, runId: string): Promise<string> {
  return await reached(async () => {
    const runs = (await records(join(root, "host/world/runs"))).filter(
      (run) => field(field(run, "attributes"), "cloving.run") === runId,
    );
    assert.ok(runs.length <= 1);
    if (runs.length === 0) return undefined;
    const sdkId = field(runs[0], "runId");
    if (typeof sdkId !== "string") throw new Error("Invalid SDK run ID");
    return sdkId;
  });
}

async function waits(root: string, sdkId: string): Promise<readonly unknown[]> {
  return (await records(join(root, "host/world/events"))).filter(
    (event) =>
      field(event, "runId") === sdkId &&
      field(event, "eventType") === "wait_created",
  );
}

export async function startPackedPolling(root: string): Promise<Checkpoint> {
  const runtimeDirectory = join(root, "host/run");
  const admitted = await call(
    { runtimeDirectory },
    {
      operation: "run",
      parameters: {
        workflowId: "approval",
        source: "declared",
        submission: { request: "synthetic-merge-request" },
        commandId: "packed-polling",
      },
    },
  );
  assert.equal(admitted["kind"], "run-admitted", JSON.stringify(admitted));
  const runId = admitted["runId"];
  if (typeof runId !== "string") throw new Error("Invalid admitted run ID");
  const sdkId = await sdkRun(root, runId);
  const wait = await reached(async () => (await waits(root, sdkId))[0]);
  const status = field(
    await call(
      { runtimeDirectory },
      { operation: "status", parameters: { runId } },
    ),
    "run",
  );
  assert.deepEqual(field(status, "budget"), { limit: 30, spent: 1 });
  assert.deepEqual(
    items(field(status, "effects")).map((effect) => field(effect, "state")),
    ["completed"],
  );
  assert.equal(
    (await readFile(join(root, "packed-polling-calls"), "utf8"))
      .trim()
      .split("\n").length,
    1,
  );
  const waitId = field(wait, "eventId");
  if (typeof waitId !== "string") throw new Error("Invalid wait event ID");
  return {
    runId,
    sdkId,
    waitId,
    resumeAt: String(field(field(wait, "eventData"), "resumeAt")),
  };
}

async function verifiedPackedPolling(
  root: string,
  checkpoint: Checkpoint,
): Promise<void> {
  const completed = await reached(async () => {
    const status = field(
      await call(
        { runtimeDirectory: join(root, "host/run") },
        { operation: "status", parameters: { runId: checkpoint.runId } },
      ),
      "run",
    );
    return field(status, "state") === "completed" ? status : undefined;
  });
  assert.deepEqual(field(completed, "outcome"), {
    kind: "handoff_requested",
    reason: null,
    promotionId: "external-condition-ready",
  });
  assert.deepEqual(field(completed, "budget"), { limit: 30, spent: 2 });
  const effects = items(field(completed, "effects"));
  assert.deepEqual(
    effects.map((effect) => field(effect, "state")),
    ["completed", "completed"],
  );
  assert.equal(await sdkRun(root, checkpoint.runId), checkpoint.sdkId);
  const retained = await waits(root, checkpoint.sdkId);
  assert.equal(retained.length, 1);
  assert.equal(field(retained[0], "eventId"), checkpoint.waitId);
  assert.equal(
    field(field(retained[0], "eventData"), "resumeAt"),
    checkpoint.resumeAt,
  );
  const calls = (await readFile(join(root, "packed-polling-calls"), "utf8"))
    .trim()
    .split("\n");
  assert.deepEqual(
    calls,
    effects.map((effect) => field(effect, "operationId")),
  );
  assert.equal(new Set(calls).size, 2);
}

export async function resumePackedPolling(
  root: string,
  settings: {
    readonly executable: string;
    readonly env: NodeJS.ProcessEnv;
    readonly checkpoint: Checkpoint;
  },
): Promise<void> {
  const { checkpoint } = settings;
  const env = {
    ...settings.env,
    NODE_OPTIONS: `${settings.env["NODE_OPTIONS"] ?? ""} --import=${JSON.stringify(pathToFileURL(join(root, "polling-clock.mjs")).href)}`,
    CLOVING_PACKED_NOW: String(Date.parse(checkpoint.resumeAt) + 600000),
  };
  const { child, output, closed } = startPackedHost({
    root,
    executable: settings.executable,
    env,
  });
  try {
    await ready(child, output);
    await verifiedPackedPolling(root, checkpoint);
    child.kill("SIGTERM");
    assert.equal(await boundedExit(closed), 0, output.text);
  } finally {
    await stopChildGroup(child);
    await boundedExit(closed);
  }
}
