import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { selfUpdater } from "../tools/self-update.ts";
import {
  repositoryGit,
  withUpdateRepository,
} from "./self-update-git-fixture.ts";

await test("CLV-085 real git preserves an ignored local file when the target tracks its path", async () => {
  await withUpdateRepository(async ({ root, repository, git, old, target }) => {
    await writeFile(join(repository, "collision.txt"), "local contents\n");
    const errors: string[] = [];
    let stops = 0;
    const updater = selfUpdater({
      directory: join(root, "host"),
      git: (argumentsList) => Promise.resolve(git(argumentsList)),
      active: () => Promise.resolve(false),
      stop: () => {
        stops += 1;
        return Promise.resolve();
      },
      error: (line) => {
        errors.push(line);
      },
    });
    assert.equal(await updater.check(), 75);
    assert.equal(stops, 1);
    assert.equal(git(["rev-parse", "HEAD"]), old);
    assert.equal(
      await readFile(join(repository, "collision.txt"), "utf8"),
      "local contents\n",
    );
    assert.equal(
      await readFile(join(root, "host", "failed-self-updates"), "utf8"),
      `${target}\n`,
    );
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /overwritten/);
  });
});

await test("CLV-085 a changed origin default branch overrides stale origin HEAD metadata", async () => {
  await withUpdateRepository(async ({ root, git, target }) => {
    const origin = repositoryGit(join(root, "origin.git"));
    origin(["branch", "replacement", target]);
    origin(["symbolic-ref", "HEAD", "refs/heads/replacement"]);
    assert.equal(
      git(["symbolic-ref", "refs/remotes/origin/HEAD"]),
      "refs/remotes/origin/main",
    );
    const updater = selfUpdater({
      directory: join(root, "host"),
      git: (argumentsList) => Promise.resolve(git(argumentsList)),
      active: () => Promise.resolve(false),
      stop: () => assert.fail("must stay on the old default branch"),
      error: (line) => assert.fail(line),
    });
    assert.equal(await updater.check(), undefined);
  });
});

await test("CLV-085 switching to a clean feature branch during stop cannot move either branch", async () => {
  await withUpdateRepository(async ({ root, git, old, target }) => {
    const errors: string[] = [];
    const updater = selfUpdater({
      directory: join(root, "host"),
      git: (argumentsList) => Promise.resolve(git(argumentsList)),
      active: () => Promise.resolve(false),
      stop: () => {
        git(["checkout", "-qb", "work"]);
        return Promise.resolve();
      },
      error: (line) => {
        errors.push(line);
      },
    });
    assert.equal(await updater.check(), 75);
    assert.equal(git(["symbolic-ref", "HEAD"]), "refs/heads/work");
    assert.equal(git(["rev-parse", "work"]), old);
    assert.equal(git(["rev-parse", "main"]), old);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /checkout changed after stop/);
    assert.equal(
      await readFile(join(root, "host", "failed-self-updates"), "utf8"),
      `${target}\n`,
    );
  });
});
