import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { check, withDoctor, type DoctorScene } from "./doctor-fixture.ts";

async function profiled(scene: DoctorScene, runner: unknown) {
  const file = join(scene.root, "profiles.json");
  await writeFile(file, JSON.stringify({ profiles: { boxed: { runner } } }));
  return check(await scene.report({ CLOVING_PROFILES: file }), "turn-runners");
}

function engine(scene: DoctorScene, refused: string) {
  return scene.program(
    "engine",
    `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(scene.root, "engine-calls"))}, JSON.stringify(args) + "\\n");
if (args[0] === ${JSON.stringify(refused)}) process.exit(1);
`,
  );
}

await test("CLV-311 doctor reports a missing engine command for a container profile", () =>
  withDoctor(async (scene) => {
    const shown = await profiled(scene, {
      kind: "container",
      engine: "missing-engine",
      image: "cloving-turn",
    });
    assert.equal(shown["result"], "fail");
    assert.equal(
      shown["detail"],
      "profile boxed: engine command not found: missing-engine",
    );
    assert.equal(
      shown["fix"],
      "Install the engine or the sandbox runtime of each profile runner, or set runner.kind to host",
    );
  }));

await test("CLV-311 doctor reports a missing image and a failed test mount of a container profile", () =>
  withDoctor(async (scene) => {
    await engine(scene, "image");
    const runner = {
      kind: "container",
      engine: "engine",
      image: "cloving-turn",
    };
    assert.equal(
      (await profiled(scene, runner))["detail"],
      "profile boxed: image not found: cloving-turn",
    );
    await engine(scene, "run");
    assert.equal(
      (await profiled(scene, runner))["detail"],
      `profile boxed: test mount failed: ${scene.repository}`,
    );
  }));

await test("CLV-311 doctor starts a test mount of the repository for a container profile", () =>
  withDoctor(async (scene) => {
    await engine(scene, "none");
    const shown = await profiled(scene, {
      kind: "container",
      engine: "engine",
      image: "cloving-turn",
    });
    assert.equal(shown["result"], "ok");
    assert.equal(shown["detail"], "Each profile runner can start: boxed");
    const calls = (await readFile(join(scene.root, "engine-calls"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line));
    const mount = `${scene.repository}:${scene.repository}:ro`;
    assert.deepEqual(calls, [
      ["--version"],
      ["image", "inspect", "cloving-turn"],
      [
        "run",
        "--rm",
        "-v",
        mount,
        "cloving-turn",
        "test",
        "-d",
        scene.repository,
      ],
    ]);
  }));

await test("CLV-311 doctor reports a missing sandbox runtime for a seatbelt profile, and host profiles pass", () =>
  withDoctor(async (scene) => {
    assert.equal(
      (await profiled(scene, { kind: "seatbelt" }))["detail"],
      "profile boxed: sandbox runtime command not found: srt",
    );
    await scene.program("srt", 'console.log("0.0.81")');
    assert.equal((await profiled(scene, { kind: "seatbelt" }))["result"], "ok");
    const shown = await profiled(scene, { kind: "host" });
    assert.equal(shown["result"], "ok");
    assert.equal(shown["detail"], "Each profile runs its turns on the host");
    assert.equal(
      check(await scene.report(), "turn-runners")["detail"],
      "Each profile runs its turns on the host",
    );
  }));

await test("CLV-311 doctor fails the runner check for a profiles file that it cannot read or that is not valid", () =>
  withDoctor(async (scene) => {
    const file = join(scene.root, "profiles.json");
    const written = [
      () => Promise.resolve(),
      () => writeFile(file, "{"),
      () => writeFile(file, '{"profiles":1}'),
    ];
    for (const write of written) {
      await write();
      const shown = check(
        await scene.report({ CLOVING_PROFILES: file }),
        "turn-runners",
      );
      assert.equal(shown["result"], "fail");
      assert.equal(shown["detail"], "invalid-setting: profiles");
    }
  }));
