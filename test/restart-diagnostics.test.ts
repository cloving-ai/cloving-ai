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
  restartDeadlineDiagnostics,
  restartCli,
} from "./restart-diagnostics-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { scene, withoutChildren } from "./self-host-fixture.ts";
import { mkdir } from "node:fs/promises";

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

await test("CLV-347 a failed restart scene ends its message with short phase lines in milliseconds after the restart request", () =>
  withFiles(
    { "restart-cli.json": '{"started":10000,"options":[]}' },
    async (directory) => {
      const phases = [
        { phase: "listener-ready", at: 9000, processId: 41 },
        { phase: "request-marked", at: 10115, processId: 41 },
        ...Array.from({ length: 60 }, (_, index) => ({
          phase: `hash-start-${String(index)}`,
          at: 10200 + index,
          processId: 52,
        })),
        { phase: "listener-ready", at: 16322, processId: 63 },
      ];
      const scene = {
        fixture: { directory },
        output: () =>
          [
            "Cloving runs",
            ...phases.map((entry) => JSON.stringify(entry)),
          ].join("\n"),
      };
      await assert.rejects(
        diagnosedRestartScene(scene, () => {
          throw new Error("The new service started 6322 ms after the request.");
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          const lines = error.message.split("\n").filter((line) => line !== "");
          const timeline = lines.slice(
            lines.findIndex((line) => line.startsWith("Restart phase times")),
          );
          assert.ok(timeline.length > 1 && timeline.length <= 9, error.message);
          assert.deepEqual(lines.slice(-timeline.length), timeline);
          assert.ok(timeline.every((line) => line.length <= 500));
          const text = timeline.join("\n");
          assert.match(text, /\b115 request-marked 41\b/);
          assert.match(text, /\b259 hash-start-59 52\b/);
          assert.match(text, /\b6322 listener-ready 63\b/);
          assert.doesNotMatch(text, /-1000 listener-ready/);
          return true;
        },
      );
    },
  ));

await test("CLV-347 a failed restart scene keeps its own failure when the restart notes hold a partial write", () =>
  withFiles({ "restart-cli.json": '{"started":100' }, async (directory) => {
    const scene = {
      fixture: { directory },
      output: () => JSON.stringify({ phase: "x", at: 200, processId: 1 }),
    };
    await assert.rejects(
      diagnosedRestartScene(scene, () => {
        throw new Error("ORIGINAL_FAILURE");
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^ORIGINAL_FAILURE\n/);
        assert.doesNotMatch(error.message, /Restart phase times/);
        return true;
      },
    );
  }));

await test("CLV-347 deadline diagnostics retain the host when cleanup has removed the runtime directory", () =>
  withFiles({}, (directory) => {
    const controller = new AbortController();
    const diagnostics = restartDeadlineDiagnostics(controller.signal);
    diagnostics.phase = "cleanup";
    diagnostics.host = "LAST_HOST_PHASE";
    diagnostics.directory = join(directory, "removed");
    const reason = new Error("ORIGINAL_DEADLINE");
    controller.abort(reason);
    assert.match(reason.message, /LAST_HOST_PHASE/);
    assert.match(reason.message, /cleanup/);
    assert.match(reason.message, /ORIGINAL_DEADLINE/);
  }));

await test("CLV-347 a pending restart retains live CLI output before cancellation", () =>
  withFiles(
    {
      "client.mjs":
        'process.stdout.write("LIVE_RESTART_OUTPUT\\n"); process.on("SIGTERM", () => process.exit(23)); setInterval(() => {}, 1000);',
    },
    async (directory) => {
      const fixture = await scene("", join(directory, "client.mjs"));
      await mkdir(fixture.directory, { recursive: true });
      const controller = new AbortController();
      const pending = restartCli(fixture, {
        arguments: ["--update"],
        signal: controller.signal,
      });
      try {
        await eventually(async () => {
          const text = await readFile(
            join(fixture.directory, "restart-cli.json"),
            "utf8",
          );
          return text.includes("LIVE_RESTART_OUTPUT") ? true : undefined;
        });
      } finally {
        controller.abort();
        assert.equal((await pending).status, 23);
      }
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

await test("CLV-347 the existing deadline reports the live phase and host and CLI evidence before Node cancels the test", () =>
  withFiles(
    {
      "restart-cli.json": '{"started":123,"options":["--update"]}',
      "claimed-restart": "CLAIM_AT_DEADLINE",
    },
    async (directory) => {
      const driver = join(directory, "deadline.test.mjs");
      await writeFile(
        driver,
        `import { test } from "node:test";
import { restartDeadlineDiagnostics } from ${JSON.stringify(new URL("./restart-diagnostics-fixture.ts", import.meta.url).href)};
const signal = AbortSignal.timeout(500);
const diagnostics = restartDeadlineDiagnostics(signal);
diagnostics.phase = "replacement-awaits-reply";
diagnostics.host = 'HOST_PHASE_AT_DEADLINE';
diagnostics.directory = import.meta.dirname;
await test("deadline scene", { signal }, async () => {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    signal.addEventListener("abort", () => {
      diagnostics.phase = "cleanup-erases-state";
      diagnostics.host = "";
      clearTimeout(timer);
      resolve();
    });
  });
});`,
      );
      const result = spawnSync(
        process.execPath,
        ["--test", "--test-concurrency=1", "--test-reporter=tap", driver],
        {
          encoding: "utf8",
          timeout: testMilliseconds(5_000),
          env: { ...process.env, NODE_TEST_CONTEXT: undefined },
        },
      );
      assert.equal(result.status, 1, result.stdout + result.stderr);
      for (const text of [
        "deadline scene",
        "replacement-awaits-reply",
        "HOST_PHASE_AT_DEADLINE",
        "CLAIM_AT_DEADLINE",
        "started",
      ])
        assert.ok(result.stdout.includes(text), result.stdout + result.stderr);
    },
  ));

await test("CLV-347 the host observer receives initialization output before the start reply", () =>
  withFiles(
    {
      "host.mjs":
        'process.stdout.write("INITIAL_HOST_PHASE\\nCloving runs\\n"); setInterval(() => {}, 1000);',
    },
    (directory) =>
      withoutChildren(async () => {
        const fixture = await scene("", join(directory, "host.mjs"));
        const live = { output: "" };
        await fixture.start(
          {},
          {
            arguments: [],
            observe: (output) => {
              live.output = output;
            },
          },
        );
        assert.match(live.output, /INITIAL_HOST_PHASE/);
      }),
  ));
