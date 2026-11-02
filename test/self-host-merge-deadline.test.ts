import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { hostedPrograms } from "../tools/self-host-processes.ts";
import { programs } from "./self-host-processes-fixture.ts";
import { withUpdateRepository } from "./self-update-git-fixture.ts";

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
