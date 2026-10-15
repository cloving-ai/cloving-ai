import assert from "node:assert/strict";
import { test } from "node:test";
import { selfUpdater } from "../tools/self-update.ts";
import { heldFetch, updateFixture } from "./self-update-fixture.ts";

await test("CLV-085 an idle clean checkout fast-forwards after stopping and requests restart", async () => {
  const fixture = updateFixture();
  const result = await selfUpdater(fixture.settings)();
  assert.equal(result, 75);
  assert.deepEqual(fixture.calls.slice(-3), [
    "stop",
    "status --porcelain --untracked-files=all --ignore-submodules=none",
    "merge --ff-only --no-overwrite-ignore after",
  ]);
  assert.equal(fixture.failures.size, 0);
});

const status =
  "status --porcelain --untracked-files=all --ignore-submodules=none";
const guards: readonly (readonly [string, string, string | undefined])[] = [
  ["fetch fails", "fetch origin", undefined],
  ["origin has no default branch", "ls-remote --symref origin HEAD", undefined],
  ["detached HEAD", "symbolic-ref HEAD", undefined],
  ["another branch", "symbolic-ref HEAD", "refs/heads/topic"],
  ["same commit", "rev-parse HEAD", "after"],
  ["diverged or ahead", "merge-base --is-ancestor before after", undefined],
  ["tracked change", status, " M src/cli.ts\n"],
  ["untracked file", status, "?? draft.txt\n"],
  ["changed submodule", status, " m nested\n"],
  ["assume-unchanged", "ls-files -v", "h src/cli.ts\n"],
  ["skip-worktree", "ls-files -v", "S src/cli.ts\n"],
];

for (const [name, command, reply] of guards)
  await test(`CLV-085 no stop or merge when ${name}`, async () => {
    const fixture = updateFixture();
    if (reply === undefined) fixture.replies.delete(command);
    else fixture.replies.set(command, reply);
    assert.equal(await selfUpdater(fixture.settings)(), undefined);
    assert.equal(fixture.calls.includes("stop"), false);
    assert.equal(
      fixture.calls.some((call) => call.startsWith("merge --")),
      false,
    );
    assert.ok(fixture.calls.includes(command));
  });

await test("CLV-085 a started turn blocks updates until its result is recorded", async () => {
  const fixture = updateFixture();
  fixture.journal.set("turn", {});
  const check = selfUpdater(fixture.settings);
  assert.equal(await check(), undefined);
  assert.equal(fixture.calls.includes("stop"), false);
  fixture.journal.set("turn", { result: "completed" });
  assert.equal(await check(), 75);
});

await test("CLV-085 a lock change reports once and disables updates until restart", async () => {
  const fixture = updateFixture();
  fixture.replies.set(
    "diff --name-only before after -- package-lock.json",
    "package-lock.json\n",
  );
  const check = selfUpdater(fixture.settings);
  assert.equal(await check(), undefined);
  assert.equal(fixture.calls.includes("stop"), false);
  const previous = [...fixture.calls];
  fixture.replies.set("diff --name-only before after -- package-lock.json", "");
  assert.equal(await check(), undefined);
  assert.deepEqual(fixture.calls, previous);
  assert.match(
    fixture.calls.at(-1) ?? "",
    /package-lock.json.*update.*install.*hand/,
  );
  assert.equal(await selfUpdater(fixture.settings)(), 75);
});

await test("CLV-085 a failed merge reports one line, records its target and restarts without retrying that target", async () => {
  const fixture = updateFixture();
  fixture.replies.delete("merge --ff-only --no-overwrite-ignore after");
  assert.equal(await selfUpdater(fixture.settings)(), 75);
  assert.deepEqual([...fixture.failures], ["after"]);
  assert.equal(
    fixture.calls.filter((call) => call.startsWith("error: ")).length,
    1,
  );
  fixture.calls.length = 0;
  assert.equal(await selfUpdater(fixture.settings)(), undefined);
  assert.equal(fixture.calls.includes("stop"), false);
});

await test("CLV-085 a change during shutdown records failure and restarts without merging", async () => {
  const fixture = updateFixture();
  const check = selfUpdater({
    ...fixture.settings,
    stop: async () => {
      await fixture.settings.stop();
      fixture.replies.set(status, "?? late.txt\n");
    },
  });
  assert.equal(await check(), 75);
  assert.deepEqual([...fixture.failures], ["after"]);
  assert.equal(
    fixture.calls.some((call) => call.startsWith("merge --")),
    false,
  );
  assert.match(fixture.calls.at(-1) ?? "", /checkout-changed/);
});

await test("CLV-085 only one update check runs at a time", async () => {
  const fixture = heldFetch();
  const check = selfUpdater(fixture.settings);
  const first = check();
  const second = check();
  try {
    assert.equal(fixture.fetches.length, 1);
  } finally {
    fixture.fetching.resolve("");
    await Promise.all([first, second]);
  }
  assert.equal(await second, undefined);
  assert.equal(await first, 75);
  assert.equal(fixture.calls.filter((call) => call === "stop").length, 1);
});
