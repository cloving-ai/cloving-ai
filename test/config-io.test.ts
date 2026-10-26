import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  acquireSettingsLock,
  releaseSettingsLock,
} from "../src/cli/config-lock.ts";
import { configScene } from "./config-cli-fixture.ts";
import { adoptionRecordPath } from "../src/cli/runtime-directory.ts";

for (const mode of [0o644, 0o660])
  await test(`CLV-206 project edits preserve shared permissions ${mode.toString(8)} and protect backups`, () => {
    using fixture = configScene();
    fixture.write(fixture.project, {
      version: 1,
      queue: { lanes: 2 },
      checks: { required: ["unit"] },
    });
    chmodSync(fixture.project, mode);
    for (const args of [
      ["set", "queue.lanes", "3"],
      ["unset", "checks.required"],
    ]) {
      const previous = readFileSync(fixture.project, "utf8");
      const result = fixture.run(args);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(statSync(fixture.project).mode & 0o777, mode);
      assert.equal(statSync(`${fixture.project}.bak`).mode & 0o777, 0o600);
      assert.equal(readFileSync(`${fixture.project}.bak`, "utf8"), previous);
    }
  });

await test("CLV-206 private edits restrict an earlier readable file and its backup", () => {
  using fixture = configScene();
  fixture.write(fixture.privateFile, { version: 1, privateTexts: ["old"] });
  chmodSync(fixture.privateFile, 0o644);
  const result = fixture.run(["set", "privateTexts", '["new"]']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(fixture.privateFile).mode & 0o777, 0o600);
  assert.equal(statSync(`${fixture.privateFile}.bak`).mode & 0o777, 0o600);
});

await test("CLV-206 malformed runtime metadata does not turn a successful settings edit into an error", () => {
  using fixture = configScene();
  const env = {
    ...fixture.environment,
    XDG_STATE_HOME: fixture.root + "/state",
  };
  const adoption = adoptionRecordPath(env, fixture.repository);
  assert.ok(adoption);
  fixture.write(adoption, { schemaVersion: 9 });
  const result = fixture.run(["set", "queue.lanes", "2", "--json"], env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /"notice":null/);
  assert.deepEqual(fixture.read(fixture.project), {
    version: 1,
    queue: { lanes: 2 },
  });
});

await test("CLV-206 failed backup replacement leaves the original file intact and removes temporaries", () => {
  using fixture = configScene();
  fixture.write(fixture.project, { version: 1, queue: { lanes: 2 } });
  const previous = readFileSync(fixture.project, "utf8");
  mkdirSync(`${fixture.project}.bak`);
  const result = fixture.run(["set", "queue.lanes", "3"]);
  assert.equal(result.status, 2);
  assert.equal(readFileSync(fixture.project, "utf8"), previous);
  assert.deepEqual(readdirSync(fixture.repository + "/.cloving"), [
    "config.json",
    "config.json.bak",
  ]);
});

await test("CLV-206 invalid JSON, unreadable files and invalid profile files report errors", () => {
  using fixture = configScene();
  writeFileSync(fixture.project, "{");
  assert.match(fixture.run(["list", "--json"]).stdout, /invalid-config-json/);
  fixture.write(fixture.project, { version: 1 });
  mkdirSync(fixture.privateFile, { recursive: true });
  assert.equal(fixture.run(["get", "queue.lanes"]).status, 2);
  rmSync(fixture.privateFile, { recursive: true });
  const profiles = fixture.root + "/profiles.json";
  fixture.write(profiles, { profiles: { bad: { unknown: true } } });
  assert.match(
    fixture.run(["get", "profiles", "--json"], { CLOVING_PROFILES: profiles })
      .stdout,
    /invalid-setting: profiles/,
  );
  const outside = fixture.run([
    "get",
    "queue.lanes",
    "--repository",
    fixture.root,
    "--json",
  ]);
  assert.equal(outside.status, 2);
  assert.match(outside.stdout, /repository-unknown/);
});

await test("CLV-206 lock errors fail closed and releasing a different owner preserves the lock", async () => {
  using fixture = configScene();
  const path = `${fixture.project}.lock`;
  const lock = await acquireSettingsLock(path);
  try {
    await releaseSettingsLock({ ...lock, owner: "different" });
    assert.equal(readlinkSync(path), lock.owner);
    await assert.rejects(
      acquireSettingsLock(path, Date.now() + 30),
      /settings-locked/,
    );
  } finally {
    await releaseSettingsLock(lock);
  }
  await releaseSettingsLock(lock);
  writeFileSync(path, "unrecognized owner");
  await assert.rejects(acquireSettingsLock(path), { code: "EINVAL" });
  await assert.rejects(
    acquireSettingsLock(fixture.root + "/missing/config.lock"),
    { code: "ENOENT" },
  );
});

await test("CLV-206 concurrent stale-lock reclamation and a stopped reaper retain both changes", async () => {
  using fixture = configScene();
  const stopped = spawnSync(process.execPath, ["-e", ""], { timeout: 1000 });
  const owner = `${String(stopped.pid)}-${randomUUID()}`;
  symlinkSync(owner, `${fixture.project}.lock`);
  symlinkSync(owner, `${fixture.project}.lock.reap`);
  await using first = fixture.start(["set", "queue.lanes", "2"]);
  await using second = fixture.start(["set", "checks.required", '["unit"]']);
  for (const result of await Promise.all([first.ended, second.ended]))
    assert.equal(result.status, 0, result.output);
  assert.deepEqual(fixture.read(fixture.project), {
    version: 1,
    queue: { lanes: 2 },
    checks: { required: ["unit"] },
  });
  assert.deepEqual(readdirSync(fixture.repository + "/.cloving"), [
    "config.json",
    "config.json.bak",
  ]);
});

await test("CLV-206 an unrecognized lock owner is preserved instead of being stolen", async () => {
  using fixture = configScene();
  const path = `${fixture.project}.lock`;
  symlinkSync("unrecognized", path);
  await assert.rejects(
    acquireSettingsLock(path, Date.now() + 30),
    /settings-locked/,
  );
  assert.equal(readlinkSync(path), "unrecognized");
});

await test("CLV-206 settings edits need no service runtime and ignore an overlong socket path", () => {
  using fixture = configScene();
  for (const env of [
    { HOME: undefined, XDG_RUNTIME_DIR: undefined, XDG_STATE_HOME: undefined },
    { CLOVING_RUNTIME_DIR: fixture.root + "/" + "long".repeat(40) },
  ]) {
    const result = fixture.run(["set", "queue.lanes", "2", "--json"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"notice":null/);
  }
});
