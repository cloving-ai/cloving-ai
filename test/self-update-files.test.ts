import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  localSelfUpdate,
  selfUpdateInterval,
} from "../tools/self-update-files.ts";
import { selfUpdater } from "../tools/self-update.ts";
import { git, scene } from "./self-host-fixture.ts";

async function ignoredCollision() {
  const fixture = await scene();
  await writeFile(join(fixture.repository, ".gitignore"), "local.txt\n");
  git(fixture.repository, ["add", ".gitignore"]);
  commit(fixture.repository);
  git(fixture.repository, ["push", "-q", "origin", "main"]);
  const upstream = join(fixture.root, "upstream");
  execFileSync("git", ["clone", "-q", fixture.origin, upstream]);
  await writeFile(join(upstream, "local.txt"), "upstream\n");
  git(upstream, ["add", "-f", "local.txt"]);
  commit(upstream);
  git(upstream, ["push", "-q", "origin", "main"]);
  await writeFile(join(fixture.repository, "local.txt"), "keep local\n");
  return { ...fixture, target: git(upstream, ["rev-parse", "HEAD"]).trim() };
}

function commit(directory: string): void {
  git(directory, [
    "-c",
    "user.name=Owner",
    "-c",
    "user.email=owner@example.invalid",
    "commit",
    "-qm",
    "Add fixture",
  ]);
}

await test("CLV-085 real git preserves an ignored local file and remembers the failed target across starts", async () => {
  const fixture = await ignoredCollision();
  const before = git(fixture.repository, ["rev-parse", "HEAD"]);
  const errors: string[] = [];
  let stops = 0;
  const settings = {
    ...localSelfUpdate(fixture),
    stop: () => {
      stops += 1;
      return Promise.resolve();
    },
    report: (message: string) => errors.push(message),
  };
  assert.equal(await selfUpdater(settings)(), 75);
  assert.equal(stops, 1);
  assert.equal(git(fixture.repository, ["rev-parse", "HEAD"]), before);
  assert.equal(
    await readFile(join(fixture.repository, "local.txt"), "utf8"),
    "keep local\n",
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /would be overwritten/);
  assert.equal(errors[0]?.includes("\n"), false);
  const restarted = localSelfUpdate(fixture);
  assert.equal(await restarted.failed(fixture.target), true);
  assert.equal(await selfUpdater({ ...settings, ...restarted })(), undefined);
  assert.equal(stops, 1);
});

await test("CLV-085 the worker journal blocks only turns with a start and no result", async () => {
  const fixture = await scene();
  const settings = localSelfUpdate(fixture);
  assert.equal(await settings.activeTurn(), false);
  const turn = join(fixture.directory, "journal", "turn");
  await mkdir(turn, { recursive: true });
  await writeFile(join(turn, "started.json"), "{}");
  assert.equal(await settings.activeTurn(), true);
  await writeFile(join(turn, "result.json"), '{"outcome":"stopped"}');
  assert.equal(await settings.activeTurn(), false);
  await mkdir(join(fixture.directory, "journal", "targets"));
  assert.equal(await settings.activeTurn(), false);
});

await test("CLV-085 uses the current default branch of origin, not a stale origin HEAD", async () => {
  const fixture = await ignoredCollision();
  git(fixture.origin, ["update-ref", "refs/heads/release", fixture.target]);
  git(fixture.origin, ["symbolic-ref", "HEAD", "refs/heads/release"]);
  let stopped = false;
  const check = selfUpdater({
    ...localSelfUpdate(fixture),
    stop: () => {
      stopped = true;
      return Promise.resolve();
    },
  });
  assert.equal(await check(), undefined);
  assert.equal(stopped, false);
});

await test("CLV-085 interval boundaries accept real-path aliases and an unset setting does not inspect paths", async () => {
  const fixture = await scene();
  const alias = join(fixture.root, "alias");
  await symlink(fixture.repository, alias);
  const locations = { repository: alias, product: fixture.repository };
  assert.equal(await selfUpdateInterval("30", locations), 30_000);
  assert.equal(await selfUpdateInterval("3600", locations), 3_600_000);
  assert.equal(
    await selfUpdateInterval(undefined, {
      repository: "absent",
      product: "absent",
    }),
    undefined,
  );
});
