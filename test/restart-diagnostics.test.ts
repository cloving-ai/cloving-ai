import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runCli, eventually } from "./service-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";
import {
  diagnosedRestartScene,
  replacementPhases,
} from "./restart-diagnostics-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

await test("CLV-347 failed restart scenes retain host phases, raw CLI timing/output and restart claim before cleanup", () =>
  withFiles(
    {
      "restart-cli.json":
        '{"started":1,"ended":2,"status":130,"stdout":"RAW_RESTART","stderr":"PENDING"}',
      "claimed-restart": "CLAIMED_REQUEST",
    },
    async (directory) => {
      const scene = {
        fixture: { directory },
        output: () => "HOST_PHASES",
      };
      await assert.rejects(
        diagnosedRestartScene(scene, () => {
          throw new Error("ORIGINAL_FAILURE");
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          for (const text of [
            "ORIGINAL_FAILURE",
            "HOST_PHASES",
            "RAW_RESTART",
            "PENDING",
            "CLAIMED_REQUEST",
          ])
            assert.ok(error.message.includes(text), error.message);
          return true;
        },
      );
    },
  ));

await test("CLV-347 restart proof waits for forwarded replacement identity, readiness and compiler phases and rejects late initial traces", async () => {
  const requested = 1000;
  const initial = [
    { phase: "service-identity", at: 100, processId: 1 },
    { phase: "listener-ready", at: 200, processId: 1 },
  ];
  const identity = { phase: "service-identity", at: 1010, processId: 2 };
  const ready = { phase: "listener-ready", at: 1020, processId: 2 };
  const snapshots = [
    initial,
    [...initial, identity],
    [
      ...initial,
      identity,
      ready,
      { phase: "recovery-end", at: 1030, processId: 2 },
    ],
    [
      ...initial,
      identity,
      ready,
      { phase: "recovery-end", at: 1030, processId: 2 },
      { phase: "compiler-end", at: 1005, processId: 3 },
    ],
  ];
  const reads = { count: 0 };
  const proof = await replacementPhases({
    requested,
    startedAt: identity.at,
    required: ["compiler-end"],
    output: () => {
      const snapshot =
        snapshots[Math.min(reads.count, snapshots.length - 1)] ?? [];
      reads.count += 1;
      return snapshot.map((entry) => JSON.stringify(entry)).join("\n");
    },
  });
  assert.deepEqual(proof.ready, ready);
  assert.ok(reads.count >= 4);
  assert.equal(
    proof.phases.some((entry) => entry.processId === 1),
    false,
  );
});

const controlledClient = `import { existsSync, writeFileSync } from "node:fs";
const root = process.env.CLOVING_RUNTIME_DIR;
const parent = process.ppid;
process.on("SIGTERM", () => { process.exit(23); });
writeFileSync(root + "/ready", "");
setInterval(() => { if (process.ppid !== parent || existsSync(root + "/reply")) process.exit(0); }, 10);`;

await test("CLV-347 a case-owned CLI waits beyond the generic helper cutoff for its actual reply", async () => {
  await withFiles({ "client.mjs": controlledClient }, async (directory) => {
    const driver = join(directory, "cutoff.mjs");
    await writeFile(
      driver,
      `import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli, eventually } from ${JSON.stringify(new URL("./service-fixture.ts", import.meta.url).href)};
const original = globalThis.setTimeout;
let cutoff;
globalThis.setTimeout = (callback, milliseconds, ...parameters) => {
  if (milliseconds === ${String(testMilliseconds(20_000))}) cutoff = () => callback(...parameters);
  return original(callback, milliseconds, ...parameters);
};
const controller = new AbortController();
const pending = runCli([], { directory: import.meta.dirname, runtime: import.meta.dirname, entryPoint: join(import.meta.dirname, "client.mjs"), signal: controller.signal });
try {
  await eventually(async () => await readFile(join(import.meta.dirname, "ready")).then(() => true, () => undefined));
  cutoff?.();
  await writeFile(join(import.meta.dirname, "reply"), "");
  assert.equal((await pending).status, 0);
} finally {
  globalThis.setTimeout = original;
  controller.abort();
}`,
    );
    const result = spawnSync(process.execPath, [driver], {
      encoding: "utf8",
      timeout: testMilliseconds(10_000),
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});

await test("CLV-347 a case-owned CLI stops when its case signal ends", async () => {
  await withFiles({ "client.mjs": controlledClient }, async (directory) => {
    const controller = new AbortController();
    const options = {
      directory,
      runtime: directory,
      entryPoint: join(directory, "client.mjs"),
      signal: controller.signal,
    };
    const pending = runCli([], options);
    await eventually(
      async () =>
        await readFile(join(directory, "ready")).then(
          () => true,
          () => undefined,
        ),
    );
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("The cancelled CLI did not end."));
      }, testMilliseconds(2_000));
    });
    try {
      controller.abort();
      assert.equal((await Promise.race([pending, deadline])).status, 23);
    } catch (error) {
      await writeFile(join(directory, "reply"), "");
      await pending;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });
});
