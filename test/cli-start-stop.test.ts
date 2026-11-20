import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  exitedCleanly,
  reached,
  scene,
  withoutChildren,
  type Scene,
} from "./self-host-fixture.ts";
import { signalGroup } from "./stop-child.ts";
import { writeQueueWorkflow } from "./workflow-folder-fixture.ts";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";

const entry = join(candidatePackageRoot, "src/cli.ts");

const queued = {
  CLOVING_QUEUE_SECONDS: "10",
  CLOVING_NEXT_COMMAND: '["false"]',
};

const worldHold = `
import { existsSync, writeSync } from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const folder = process.env.WORLD_HOLD_FOLDER;
const release = join(folder, "release");
const held = (phase) => writeSync(2, "World " + phase + " held\\n");
if (process.argv[1]?.endsWith("/start.mjs") && process.env.WORLD_HOLD === "start") {
  const readFile = promises.readFile;
  promises.readFile = async (path, ...rest) => {
    if (String(path).endsWith("/version.txt")) {
      held("start");
      while (!existsSync(release)) await delay(10);
    }
    return readFile(path, ...rest);
  };
  syncBuiltinESMExports();
}
if (process.argv[1]?.endsWith("/start.mjs") && process.env.WORLD_HOLD === "close") {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const close = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function () {
    if (this.location()?.endsWith("/world.db")) {
      held("close");
      while (!existsSync(release));
    }
    return close.call(this);
  };
}
`;

async function holding(
  fixture: Scene,
  phase: "start" | "close",
): Promise<NodeJS.ProcessEnv> {
  const preload = join(fixture.root, "world-hold.mjs");
  await writeFile(preload, worldHold);
  return {
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    WORLD_HOLD: phase,
    WORLD_HOLD_FOLDER: fixture.root,
  };
}

async function stopGroupThenRelease(
  fixture: Scene,
  service: ChildProcess,
): Promise<void> {
  assert.notEqual(service.pid, undefined);
  signalGroup(Number(service.pid), "SIGTERM");
  await writeFile(join(fixture.root, "release"), "");
}

await test("#857 a stop at once after Cloving runs ends with exit code 0", () =>
  withoutChildren(async () => {
    const fixture = await scene(undefined, entry);
    await writeQueueWorkflow(join(fixture.repository, ".cloving/workflows"));
    let stopped = false;
    const service = await fixture.start(queued, {
      arguments: [],
      observe: (output, child) => {
        if (!stopped && output.includes("Cloving runs")) {
          stopped = true;
          child.kill("SIGTERM");
        }
      },
    });
    await exitedCleanly(service);
  }));

await test("#857 a stop during the World start ends with exit code 0", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    const service = await fixture.startUntil(
      "World start held",
      await holding(fixture, "start"),
    );
    await stopGroupThenRelease(fixture, service);
    await exitedCleanly(service);
  }));

await test("#857 a stop during the World close ends with exit code 0", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    const world = join(fixture.directory, "world");
    await mkdir(world, { recursive: true });
    await writeFile(join(world, "world.db"), "");
    let output = "";
    const service = await fixture.start(await holding(fixture, "close"), {
      arguments: [],
      observe: (text) => {
        output = text;
      },
    });
    service.kill("SIGTERM");
    await reached(() =>
      Promise.resolve(output.includes("World close held") ? true : undefined),
    );
    await stopGroupThenRelease(fixture, service);
    await exitedCleanly(service);
  }));
