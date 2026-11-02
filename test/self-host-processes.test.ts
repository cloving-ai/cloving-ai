import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { hostedPrograms } from "../tools/self-host-processes.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { reached } from "./self-host-fixture.ts";
import {
  programs,
  readyPrograms,
  stalledCheck,
} from "./self-host-processes-fixture.ts";
import { withUpdateRepository } from "./self-update-git-fixture.ts";

afterEach(() => {
  mock.restoreAll();
});

for (const factor of [undefined, "3"])
  for (const signal of ["SIGTERM", "deadline"])
    await test(`CLV-142 stalledCheck scales ${signal} by ${factor ?? "the default factor"}`, async () => {
      await withFiles(
        { "git-pid": "1", "daemon-ready": "2", "watch-ready": "3" },
        async (root) => {
          const previous = process.env["CLOVING_CHECK_TIME_FACTOR"];
          const spawn = childProcess.spawnSync;
          const kill = Object.getOwnPropertyDescriptor(process, "kill");
          let timeout: number | undefined;
          process.kill = () => true;
          if (factor === undefined)
            delete process.env["CLOVING_CHECK_TIME_FACTOR"];
          else process.env["CLOVING_CHECK_TIME_FACTOR"] = factor;
          Object.defineProperty(childProcess, "spawnSync", {
            configurable: true,
            value: (...argumentsList: Parameters<typeof spawn>[number][]) => {
              const options = argumentsList[2];
              timeout =
                typeof options === "object" && "timeout" in options
                  ? options.timeout
                  : undefined;
              return { status: 0 };
            },
          });
          syncBuiltinESMExports();
          try {
            const result = await stalledCheck(root, {
              repository: root,
              command: "fetch",
              signal,
            });
            assert.equal(result.status, 0);
            assert.equal(
              timeout,
              (signal === "deadline" ? 35000 : 10000) * Number(factor ?? 1),
            );
          } finally {
            if (kill) Object.defineProperty(process, "kill", kill);
            else Reflect.deleteProperty(process, "kill");
            childProcess.spawnSync = spawn;
            syncBuiltinESMExports();
            if (previous === undefined)
              delete process.env["CLOVING_CHECK_TIME_FACTOR"];
            else process.env["CLOVING_CHECK_TIME_FACTOR"] = previous;
          }
        },
      );
    });

for (const phoneRelay of ["on", "off"])
  await test(`CLV-187 the host starts the phone relay child unless CLOVING_PHONE_RELAY is off (${phoneRelay})`, async () => {
    await withFiles({}, async (root) => {
      const relay = phoneRelay === "on" ? ["relay"] : [];
      const paths = await programs(root, {
        daemonMilliseconds: 100,
        readyPrograms: ["watch", ...relay],
      });
      const status = await hostedPrograms({
        ...paths,
        repository: root,
        runtime: join(root, "host/run"),
        directory: join(root, "host"),
        watchPort: "3663",
        phoneRelay,
        updateMilliseconds: undefined,
      });
      assert.equal(status, 0);
      assert.deepEqual(await readyPrograms(root), [
        "daemon",
        ...relay,
        "watch",
      ]);
      assert.equal(
        await readFile(join(root, "relay-runtime"), "utf8").catch(
          () => "not started",
        ),
        phoneRelay === "on" ? join(root, "host/run") : "not started",
      );
    });
  });

await test("CLV-208 host shutdown signals each child once while awaiting its exit", async () => {
  await withFiles({}, async (root) => {
    const paths = await programs(root);
    const prototype = childProcess.ChildProcess.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "kill");
    assert.ok(descriptor);
    const kill: unknown = descriptor.value;
    assert.ok(typeof kill === "function");
    const signals: Array<number | undefined> = [];
    const forwarded: Array<NodeJS.Signals | number | undefined> = [];
    const errors: string[] = [];
    mock.method(process.stderr, "write", (line: string | Uint8Array) => {
      errors.push(String(line));
      return true;
    });
    prototype.kill = function (signal) {
      forwarded.push(signal);
      if (signal === "SIGTERM") signals.push(this.pid);
      return Reflect.apply(kill, this, [signal]) === true;
    };
    const hosting = hostedPrograms({
      ...paths,
      repository: root,
      runtime: join(root, "host/run"),
      directory: join(root, "host"),
      watchPort: "3663",
      phoneRelay: "on",
      updateMilliseconds: undefined,
    });
    try {
      await reached(async () =>
        (await readyPrograms(root)).length === 3 ? true : undefined,
      );
      process.emit("SIGTERM");
      assert.equal(await hosting, 0);
      assert.equal(signals.length, 3);
      assert.equal(new Set(signals).size, 3);
      assert.deepEqual(forwarded, ["SIGTERM", "SIGTERM", "SIGTERM"]);
      assert.deepEqual(errors, []);
    } finally {
      process.emit("SIGTERM");
      try {
        await hosting;
      } finally {
        Object.defineProperty(prototype, "kill", descriptor);
      }
    }
  });
});

await test("CLV-093 the watch child gets the service repository while its current directory is the product", async () => {
  await withUpdateRepository(async ({ root, repository }) => {
    const paths = await programs(root, { daemonMilliseconds: 300 });
    const program = join(paths.product, "src/cli.ts");
    const source = await readFile(program, "utf8");
    await writeFile(
      program,
      source +
        `\nwriteFileSync(${JSON.stringify(join(root, "watch-context"))}, JSON.stringify({ repository: process.env["CLOVING_WATCH_REPOSITORY"], cwd: process.cwd() }));\n`,
    );
    assert.equal(
      await hostedPrograms({
        ...paths,
        repository,
        runtime: join(root, "host/run"),
        directory: join(root, "host"),
        watchPort: "0",
        phoneRelay: "on",
        updateMilliseconds: undefined,
      }),
      0,
    );
    const context: unknown = JSON.parse(
      await readFile(join(root, "watch-context"), "utf8"),
    );
    assert.deepEqual(context, {
      repository,
      cwd: await realpath(paths.product),
    });
  });
});
