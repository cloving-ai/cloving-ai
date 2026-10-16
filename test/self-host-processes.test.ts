import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { hostedPrograms } from "../tools/self-host-processes.ts";
import { programs, stalledCheck } from "./self-host-processes-fixture.ts";
import { withUpdateRepository } from "./self-update-git-fixture.ts";

await test("CLV-085 the host stops and awaits daemon and watch before fast-forwarding", async () => {
  await withUpdateRepository(async ({ root, repository, git, target }) => {
    const paths = await programs(root);
    const status = await hostedPrograms({
      ...paths,
      repository,
      runtime: join(root, "host/run"),
      directory: join(root, "host"),
      watchPort: "3663",
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
    const paths = await programs(root, { daemonMilliseconds: 100 });
    const fetchHead = join(repository, ".git", "FETCH_HEAD");
    await writeFile(fetchHead, "no check\n");
    assert.equal(
      await hostedPrograms({
        ...paths,
        repository,
        runtime: join(root, "host/run"),
        directory: join(root, "host"),
        watchPort: "3663",
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
