import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  chmod,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { hostedPrograms } from "../tools/self-host-processes.ts";
import { programs, stalledCheck } from "./self-host-processes-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { withUpdateRepository } from "./self-update-git-fixture.ts";

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

async function readyPrograms(root: string): Promise<readonly string[]> {
  return (await readdir(root))
    .filter((name) => name.endsWith("-ready"))
    .map((name) => name.replace(/-ready$/, ""))
    .sort();
}

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
      if (phoneRelay === "on")
        assert.equal(
          await readFile(join(root, "relay-runtime"), "utf8"),
          join(root, "host/run"),
        );
    });
  });

await test("CLV-085 the host stops and awaits daemon and watch before fast-forwarding", async () => {
  await withUpdateRepository(async ({ root, repository, git, target }) => {
    const paths = await programs(root);
    const status = await hostedPrograms({
      ...paths,
      repository,
      runtime: join(root, "host/run"),
      directory: join(root, "host"),
      watchPort: "3663",
      phoneRelay: "on",
      updateMilliseconds: 300,
    });
    assert.equal(status, 75);
    assert.equal(git(["rev-parse", "HEAD"]), target);
    assert.equal(
      await readFile(join(root, "daemon-stopped"), "utf8"),
      "stopped",
    );
    assert.equal(
      await readFile(join(root, "watch-stopped"), "utf8"),
      "stopped",
    );
  });
});

await test("CLV-085 a local merge can finish after the network deadline", async () => {
  await withUpdateRepository(async ({ root, repository, git, target }) => {
    const paths = await programs(root);
    const hook = join(repository, ".git/hooks/post-merge");
    await writeFile(
      hook,
      `#!${process.execPath}\nsetTimeout(() => {}, 31000);\n`,
    );
    await chmod(hook, 0o755);
    assert.equal(
      await hostedPrograms({
        ...paths,
        repository,
        runtime: join(root, "host/run"),
        directory: join(root, "host"),
        watchPort: "off",
        phoneRelay: "on",
        updateMilliseconds: 300,
      }),
      75,
    );
    assert.equal(git(["rev-parse", "HEAD"]), target);
    await assert.rejects(readFile(join(root, "host/failed-self-updates")), {
      code: "ENOENT",
    });
  });
});

await test("CLV-085 without the setting the host never fetches and preserves normal exit", async () => {
  await withUpdateRepository(async ({ root, repository, git, old }) => {
    const paths = await programs(root, {
      daemonMilliseconds: 100,
      watchStartupMilliseconds: 300,
    });
    const fetchHead = join(repository, ".git", "FETCH_HEAD");
    await writeFile(fetchHead, "no check\n");
    assert.equal(
      await hostedPrograms({
        ...paths,
        repository,
        runtime: join(root, "host/run"),
        directory: join(root, "host"),
        watchPort: "3663",
        phoneRelay: "on",
        updateMilliseconds: undefined,
      }),
      0,
    );
    assert.equal(await readFile(fetchHead, "utf8"), "no check\n");
    assert.equal(git(["rev-parse", "HEAD"]), old);
    assert.equal(
      await readFile(join(root, "watch-stopped"), "utf8"),
      "stopped",
    );
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  await test(`CLV-085 ${signal} awaits a local merge before shutdown completes`, async () => {
    await withUpdateRepository(async ({ root, repository, git, target }) => {
      const result = await stalledCheck(root, {
        repository,
        command: "merge",
        signal,
      });
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.status, 75, result.stderr);
      assert.equal(git(["rev-parse", "HEAD"]), target);
      assert.equal(
        await readFile(join(root, "merge-completed"), "utf8"),
        "completed",
      );
      await assert.rejects(readFile(join(root, "host/failed-self-updates")), {
        code: "ENOENT",
      });
    });
  });
}

await test("CLV-196 the merge fixture completes without directory notifications", async () => {
  await withUpdateRepository(async ({ root, repository, git, target }) => {
    const preload = join(root, "quiet-watch.mjs");
    await writeFile(
      preload,
      'import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const watch = fs.watch; fs.watch = path => watch(path, () => {}); syncBuiltinESMExports();',
    );
    const previous = process.env["NODE_OPTIONS"];
    process.env["NODE_OPTIONS"] =
      `${previous ?? ""} --import=${pathToFileURL(preload).href}`;
    try {
      const result = await stalledCheck(root, {
        repository,
        command: "merge",
        signal: "SIGTERM",
      });
      assert.equal(
        await readFile(join(root, "shutdown-observed"), "utf8"),
        "observed",
      );
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.status, 75, result.stderr);
      assert.equal(git(["rev-parse", "HEAD"]), target);
      assert.equal(
        await readFile(join(root, "merge-completed"), "utf8"),
        "completed",
      );
    } finally {
      if (previous === undefined) delete process.env["NODE_OPTIONS"];
      else process.env["NODE_OPTIONS"] = previous;
    }
  });
});

for (const command of ["fetch", "remote"]) {
  for (const signal of ["SIGINT", "SIGTERM", "daemon"]) {
    await test(`CLV-085 ${signal} cancels stalled git ${command} and waits for children`, async () => {
      await withUpdateRepository(async ({ root, repository, git, old }) => {
        const result = await stalledCheck(root, {
          repository,
          command,
          signal,
        });
        assert.equal(result.error, undefined, result.stderr);
        assert.equal(result.status, 0, result.stderr);
        for (const name of ["daemon", "watch"])
          assert.equal(
            await readFile(join(root, `${name}-stopped`), "utf8"),
            "stopped",
          );
        assert.equal(git(["rev-parse", "HEAD"]), old);
      });
    });
  }
  await test(`CLV-085 stalled git ${command} reaches its deadline and polling recovers`, async () => {
    await withUpdateRepository(async ({ root, repository, git, old }) => {
      const result = await stalledCheck(root, {
        repository,
        command,
        signal: "deadline",
      });
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(git(["rev-parse", "HEAD"]), old);
    });
  });
}

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
