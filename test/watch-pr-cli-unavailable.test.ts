import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { testMilliseconds } from "./test-timing.ts";
import { prOutput } from "./watch-pr-fixture.ts";
import { setTimeout as delay } from "node:timers/promises";
import { alive, until } from "./claude-worker-fixture.ts";
import { fields, withHarness } from "./service-fixture.ts";
import {
  configuredPrWatch,
  directPrWatch,
  ghRequest,
  recordedPrJournal,
  releasePr,
  stoppedPrCard,
  stoppedPrRun,
} from "./watch-pr-cli-fixture.ts";
import {
  watchData,
  watchReplies,
  withWatchService,
} from "./watch-service-fixture.ts";

await test("CLV-093 request readiness waits for a fully written process ID", async () => {
  await withHarness(async (harness) => {
    const root = dirname(harness.runtimeDirectory);
    await writeFile(join(root, "gh-request"), "[]");
    await writeFile(join(root, "gh-pid"), "");
    let ready = false;
    const request = ghRequest(harness.runtimeDirectory).then((value) => {
      ready = true;
      return value;
    });
    try {
      await delay(50);
      assert.equal(ready, false);
    } finally {
      await writeFile(join(root, "gh-pid"), String(process.pid));
      await request;
    }
    assert.deepEqual(await request, []);
  });
});

await test("CLV-162 the fake GitHub command publishes its request only after its PID is ready", async () => {
  const replies = watchReplies({ runs: [stoppedPrRun()] });
  await withWatchService(
    {
      answer: replies.answer,
      configure: async (runtime) => {
        const options = await configuredPrWatch(runtime);
        const program = join(dirname(runtime), "fake gh.mjs");
        const source = await readFile(program, "utf8");
        const pidWrite =
          'writeFileSync(root + "/gh-pid", String(process.pid));';
        assert.ok(source.includes(pidWrite));
        await writeFile(
          program,
          source.replace(
            pidWrite,
            `writeFileSync(root + "/pid-entered", "ready");
while (!existsSync(root + "/release-pid")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
${pidWrite}`,
          ),
        );
        return options;
      },
    },
    async (watch, runtime) => {
      await recordedPrJournal(runtime);
      await watchData(watch.address);
      const root = dirname(runtime);
      await until(async () =>
        Boolean(
          await readFile(join(root, "pid-entered"), "utf8").catch(() => ""),
        ),
      );
      await assert.rejects(readFile(join(root, "gh-request")), {
        code: "ENOENT",
      });
      await writeFile(join(root, "release-pid"), "");
      await ghRequest(runtime);
      assert.ok(Number(await readFile(join(root, "gh-pid"), "utf8")) > 0);
    },
  );
});

await test("CLV-093 direct watch server without PR settings retains local data and reports configuration status", async () => {
  const replies = watchReplies({ runs: [stoppedPrRun()] });
  await withWatchService(
    { answer: replies.answer, launch: directPrWatch },
    async (watch, runtime) => {
      await recordedPrJournal(runtime);
      const model = await watchData(watch.address);
      assert.equal(model["service"], "up");
      const card = stoppedPrCard(model);
      assert.equal(fields(card["completionMark"])["text"], "Needs attention");
      assert.deepEqual(card["pullRequestObservation"], {
        status: "unavailable",
        failure: "configuration",
      });
    },
  );
});

for (const [failure, environment] of [
  ["configuration", { CLOVING_WATCH_REPOSITORY: "" }],
  ["configuration", { CLOVING_GH_COMMAND: "not-json" }],
  ["command", { CLOVING_GH_COMMAND: '["missing-cloving-test-gh-command"]' }],
] as const)
  await test(`CLV-093 CLI refuses unavailable settings and tooling ${JSON.stringify(environment)}`, async () => {
    const replies = watchReplies({ runs: [stoppedPrRun()] });
    const configure = async (runtime: string) => {
      const options = await configuredPrWatch(runtime);
      return {
        ...options,
        environment: { ...options.environment, ...environment },
      };
    };
    await withWatchService(
      { answer: replies.answer, configure },
      async (watch, runtime) => {
        await recordedPrJournal(runtime);
        await until(
          async () =>
            fields(
              stoppedPrCard(await watchData(watch.address))[
                "pullRequestObservation"
              ],
            )["status"] === "unavailable",
        );
        const model = await watchData(watch.address);
        assert.equal(model["service"], "up");
        assert.deepEqual(stoppedPrCard(model)["pullRequestObservation"], {
          status: "unavailable",
          failure,
        });
        await assert.rejects(readFile(join(dirname(runtime), "gh-request")), {
          code: "ENOENT",
        });
      },
    );
  });

await test("CLV-093 CLI terminates a held GitHub command after five seconds", async () => {
  const replies = watchReplies({ runs: [stoppedPrRun()] });
  await withWatchService(
    { answer: replies.answer, configure: configuredPrWatch },
    async (watch, runtime) => {
      await recordedPrJournal(runtime);
      const first = await watchData(watch.address);
      assert.deepEqual(stoppedPrCard(first)["pullRequestObservation"], {
        status: "pending",
      });
      await ghRequest(runtime);
      const pid = Number(
        await readFile(join(dirname(runtime), "gh-pid"), "utf8"),
      );
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      await until(
        async () =>
          fields(
            stoppedPrCard(await watchData(watch.address))[
              "pullRequestObservation"
            ],
          )["failure"] === "timeout",
      );
      const model = await watchData(watch.address);
      assert.equal(model["service"], "up");
      assert.deepEqual(stoppedPrCard(model)["pullRequestObservation"], {
        status: "unavailable",
        failure: "timeout",
      });
      await until(() => !alive(pid));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    },
  );
});

for (const [condition, notifications] of [
  ["lost", 0],
  ["duplicated", 2],
] as const)
  await test(`CLV-093 the GitHub fixture emits one response when filesystem notifications are ${condition}`, async () => {
    await withHarness(async (harness) => {
      await configuredPrWatch(harness.runtimeDirectory);
      const program = pathToFileURL(
        join(dirname(harness.runtimeDirectory), "fake gh.mjs"),
      ).href;
      const completion = promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const watch = fs.watch;
fs.watch = (path, listener) => watch(path, (...arguments_) => {
  for (let count = 0; count < ${String(notifications)}; count += 1)
    listener(...arguments_);
});
syncBuiltinESMExports();
await import(${JSON.stringify(program)});`,
        ],
        {
          timeout: testMilliseconds(10000),
          killSignal: "SIGKILL",
          env: { ...process.env, NODE_V8_COVERAGE: undefined },
        },
      );
      try {
        await ghRequest(harness.runtimeDirectory);
        await releasePr(harness.runtimeDirectory, true);
      } finally {
        const output = await completion;
        assert.equal(output.stdout, prOutput(true).stdout);
        assert.equal(output.stderr, "");
      }
    });
  });
