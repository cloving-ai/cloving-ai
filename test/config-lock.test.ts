import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { configScene } from "./config-cli-fixture.ts";

await test("CLV-206 simultaneous setters hold a lock before reading and preserve both changes", async () => {
  using fixture = configScene();
  const lock = `${fixture.project}.lock`;
  symlinkSync(`${String(process.pid)}-${randomUUID()}`, lock);
  await using first = fixture.start(["set", "queue.lanes", "2"]);
  await using second = fixture.start(["set", "checks.required", '["unit"]']);
  await setTimeout(500);
  assert.equal(existsSync(fixture.project), false);
  fixture.write(fixture.project, {
    version: 1,
    tickets: { command: ["keep"] },
  });
  rmSync(lock);
  const results = await Promise.all([first.ended, second.ended]);
  for (const result of results) assert.equal(result.status, 0, result.output);
  assert.deepEqual(fixture.read(fixture.project), {
    version: 1,
    tickets: { command: ["keep"] },
    queue: { lanes: 2 },
    checks: { required: ["unit"] },
  });
  assert.equal(existsSync(lock), false);
  assert.ok(
    readdirSync(fixture.repository + "/.cloving").every(
      (name) => !name.endsWith(".tmp"),
    ),
  );
});

await test("CLV-206 a stopped process lock is reclaimed", () => {
  using fixture = configScene();
  const stopped = spawnSync(process.execPath, ["-e", ""], { timeout: 1000 });
  symlinkSync(
    `${String(stopped.pid)}-${randomUUID()}`,
    `${fixture.project}.lock`,
  );
  const result = fixture.run(["set", "queue.lanes", "3"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fixture.read(fixture.project), {
    version: 1,
    queue: { lanes: 3 },
  });
  assert.deepEqual(readdirSync(fixture.repository + "/.cloving"), [
    "config.json",
  ]);
});

await test("CLV-206 an active settings lock times out after ten seconds without changes", () => {
  using fixture = configScene();
  fixture.write(fixture.project, { version: 1 });
  const original = readFileSync(fixture.project, "utf8");
  symlinkSync(
    `${String(process.pid)}-${randomUUID()}`,
    `${fixture.project}.lock`,
  );
  const started = Date.now();
  const result = fixture.run(["set", "queue.lanes", "4", "--json"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /settings-locked/);
  assert.ok(Date.now() - started >= 10000);
  assert.ok(Date.now() - started < 13000);
  assert.equal(readFileSync(fixture.project, "utf8"), original);
  assert.equal(existsSync(`${fixture.project}.bak`), false);
});
