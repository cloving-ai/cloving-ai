import assert from "node:assert/strict";
import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  launchedProcess,
  launchMarker,
} from "../src/daemon/detached-process.ts";
import { until } from "./claude-worker-fixture.ts";
import { stopChildGroup } from "./stop-child.ts";

function holdAfterReceipt(exit: string): string {
  const preload = join(dirname(exit), "hold-receipt.cjs");
  writeFileSync(
    preload,
    `const fs = require("node:fs");
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  rename(from, to);
  if (to !== ${JSON.stringify(exit)}) return;
  fs.writeFileSync(to + ".held", "");
  process.kill(process.pid, "SIGSTOP");
};`,
  );
  return preload;
}

export async function receiptHeldLauncher(folder: string) {
  const exit = join(folder, "turn.exit.json");
  const preload = holdAfterReceipt(exit);
  const marker = launchMarker(folder, {
    exit,
    output: join(folder, "turn.jsonl"),
    offset: 0,
    configuration: join(folder, "configuration"),
  });
  const started = launchedProcess({
    executable: process.execPath,
    arguments: [
      "-e",
      'const fs = require("node:fs"); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) clearInterval(timer); }, 10);',
      join(folder, "finish"),
    ],
    environment: {
      ...process.env,
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
    },
    directory: folder,
    descriptors: [
      "ignore",
      openSync(marker.launch.output, "w"),
      openSync(join(folder, "stderr"), "w"),
    ],
    marker,
  });
  started.child.ref();
  const state = { exit: "pending" };
  started.child.once("exit", (_code, signal) => {
    state.exit = signal ?? "exited";
  });
  try {
    const launch = await started.launch;
    assert.ok(launch);
    writeFileSync(join(folder, "finish"), "");
    await until(() => existsSync(`${exit}.held`));
    return {
      launch: { ...launch, ...marker.launch },
      state,
      evidence: () =>
        stopEvidence({ folder, processIds: [launch.processId], child: state }),
      close: () => stopChildGroup(started.child, { graceMilliseconds: 100 }),
    };
  } catch (error) {
    await stopChildGroup(started.child, { graceMilliseconds: 100 });
    throw error;
  }
}

export function stopEvidence(input: {
  readonly folder: string;
  readonly processIds: readonly number[];
  readonly child?: { readonly exit: string };
}): string {
  const { folder, processIds, child } = input;
  const listed = spawnSync(
    "ps",
    [
      "-ww",
      ...["pid", "ppid", "pgid", "stat", "lstart", "command"].flatMap(
        (name) => ["-o", `${name}=`],
      ),
      "-p",
      processIds.join(","),
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  const records = Object.fromEntries(
    ["started.json", "attempt-1.json", "turn.exit.json", "result.json"].map(
      (name) => {
        const path = join(folder, name);
        return [name, existsSync(path) ? readFileSync(path, "utf8") : null];
      },
    ),
  );
  return JSON.stringify({
    processIds,
    processStatus: listed.status,
    processes: listed.stdout,
    processError: listed.stderr,
    child,
    records,
  });
}
