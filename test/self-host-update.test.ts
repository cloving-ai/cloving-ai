import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { hostedPrograms } from "../tools/self-host-processes.ts";
import { programs } from "./self-host-processes-fixture.ts";
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

await test("CLV-085 a host without self-update removes a pending mark that an earlier host left", async () => {
  await withUpdateRepository(async ({ root, repository }) => {
    const paths = await programs(root, {
      daemonMilliseconds: 100,
      watchStartupMilliseconds: 300,
    });
    const mark = join(root, "host", "pending-self-update");
    await mkdir(join(root, "host"), { recursive: true });
    await writeFile(mark, `${String(Date.now())}\n`);
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
    await assert.rejects(readFile(mark), { code: "ENOENT" });
  });
});
