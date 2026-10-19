import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { selfUpdater } from "../tools/self-update.ts";
import {
  lockCommand,
  mergeCommand,
  statusCommand,
  withUpdate,
} from "./self-update-fixture.ts";

await test("CLV-085 an idle clean checkout fast-forwards after stopping and requests restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloving-update-"));
  const actions: string[] = [];
  const replies: Readonly<Record<string, string>> = {
    "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/main\n",
    "symbolic-ref HEAD": "refs/heads/main\n",
    "rev-parse HEAD": "old\n",
    "rev-parse refs/remotes/origin/main": "target\n",
    "ls-files -v": "H package-lock.json\n",
  };
  const updater = selfUpdater({
    directory,
    git: (argumentsList) => {
      const command = argumentsList.join(" ");
      actions.push(command);
      return Promise.resolve(replies[command] ?? "");
    },
    active: () => Promise.resolve(false),
    stop: () => {
      actions.push("stop");
      return Promise.resolve();
    },
    error: (line) => assert.fail(line),
  });
  try {
    assert.equal(await updater.check(), 75);
    assert.deepEqual(actions, [
      "fetch origin",
      "remote set-head origin --auto",
      "symbolic-ref refs/remotes/origin/HEAD",
      "symbolic-ref HEAD",
      "rev-parse HEAD",
      "rev-parse refs/remotes/origin/main",
      "merge-base --is-ancestor old target",
      "status --porcelain --untracked-files=all --ignore-submodules=none",
      "ls-files -v",
      "diff --exit-code old target -- package-lock.json",
      "stop",
      "status --porcelain --untracked-files=all --ignore-submodules=none",
      "ls-files -v",
      "symbolic-ref HEAD",
      "rev-parse HEAD",
      "merge --ff-only --no-overwrite-ignore target",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const [command, output] of [
  ["symbolic-ref HEAD", "refs/heads/work\n"],
  ["rev-parse refs/remotes/origin/main", "old\n"],
  [statusCommand, "?? untracked.txt\n"],
  [statusCommand, " M tracked.txt\n"],
  ["ls-files -v", "h hidden.txt\n"],
  ["ls-files -v", "S sparse.txt\n"],
  ["ls-files -v", "s hidden-sparse.txt\n"],
] as const) {
  await test(`CLV-085 guard ${command}: ${output.trim()}`, async () => {
    await withUpdate(async (fixture) => {
      fixture.replies[command] = output;
      assert.equal(await fixture.updater.check(), undefined, command);
      assert.equal(fixture.actions.at(-1), command);
      assert.equal(fixture.actions.includes("stop"), false);
      assert.equal(fixture.actions.includes(mergeCommand), false);
    });
  });
}

for (const command of [
  "fetch origin",
  "remote set-head origin --auto",
  "symbolic-ref HEAD",
  "symbolic-ref refs/remotes/origin/HEAD",
  "merge-base --is-ancestor old target",
]) {
  await test(`CLV-085 git failure at ${command} fails closed`, async () => {
    await withUpdate(async (fixture) => {
      fixture.failures.set(command, new Error("git refused"));
      assert.equal(await fixture.updater.check(), undefined);
      assert.equal(fixture.actions.at(-1), command);
      assert.deepEqual(fixture.errors, []);
    });
  });
}

await test("CLV-085 an unfinished worker turn prevents the lock check and stop", async () => {
  await withUpdate(async (fixture) => {
    fixture.worker.active = true;
    assert.equal(await fixture.updater.check(), undefined);
    assert.equal(fixture.actions.at(-1), "journal");
    assert.equal(fixture.actions.includes("stop"), false);
  });
});

await test("CLV-085 a lock change asks for manual update once and disables checks until restart", async () => {
  await withUpdate(async (fixture) => {
    fixture.failures.set(lockCommand, new Error("lock changed"));
    assert.equal(await fixture.updater.check(), undefined);
    const actions = [...fixture.actions];
    fixture.failures.clear();
    assert.equal(await fixture.updater.check(), undefined);
    assert.deepEqual(fixture.actions, actions);
    assert.equal(fixture.actions.includes("stop"), false);
    assert.equal(fixture.errors.length, 1);
    assert.match(
      String(fixture.errors[0]),
      /package-lock.json.*update.*install.*hand/,
    );
    assert.equal(String(fixture.errors[0]).trim().split("\n").length, 1);
    assert.equal(await selfUpdater(fixture.settings).check(), 75);
  });
});

await test("CLV-109 a root-only lock change fast-forwards and requests restart", async () => {
  await withUpdate(async (fixture) => {
    fixture.failures.set(lockCommand, new Error("lock changed"));
    const installed = { "node_modules/example": { version: "1.0.0" } };
    fixture.replies["show old:package-lock.json"] = JSON.stringify({
      version: "1.0.0",
      packages: { "": { version: "1.0.0" }, ...installed },
    });
    fixture.replies["show target:package-lock.json"] = JSON.stringify({
      version: "1.0.1",
      packages: { "": { version: "1.0.1" }, ...installed },
    });
    assert.equal(await fixture.updater.check(), 75);
    assert.deepEqual(fixture.errors, []);
    assert.deepEqual(fixture.actions.slice(-9), [
      "show old:package-lock.json",
      "show target:package-lock.json",
      "journal",
      "stop",
      statusCommand,
      "ls-files -v",
      "symbolic-ref HEAD",
      "rev-parse HEAD",
      mergeCommand,
    ]);
  });
});

await test("CLV-109 an installed-package change disables updates without stopping", async () => {
  await withUpdate(async (fixture) => {
    fixture.failures.set(lockCommand, new Error("lock changed"));
    fixture.replies["show old:package-lock.json"] = JSON.stringify({
      packages: { "node_modules/example": { version: "1.0.0" } },
    });
    fixture.replies["show target:package-lock.json"] = JSON.stringify({
      packages: { "node_modules/example": { version: "2.0.0" } },
    });
    assert.equal(await fixture.updater.check(), undefined);
    assert.deepEqual(fixture.errors, [
      "Self-update disabled: package-lock.json changed; update and install by hand.\n",
    ]);
    assert.deepEqual(fixture.actions.slice(-3), [
      lockCommand,
      "show old:package-lock.json",
      "show target:package-lock.json",
    ]);
    assert.equal(fixture.actions.includes("stop"), false);
    assert.equal(fixture.actions.includes(mergeCommand), false);
    const actions = [...fixture.actions];
    assert.equal(await fixture.updater.check(), undefined);
    assert.deepEqual(fixture.actions, actions);
    assert.equal(fixture.errors.length, 1);
  });
});
