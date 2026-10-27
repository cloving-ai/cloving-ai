import "../src/cli/doctor-service.ts";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import net from "node:net";
import { replyLine } from "../src/protocol.ts";
import { test } from "node:test";
import {
  adoptionRecordPath,
  runtimeDirectory,
} from "../src/cli/runtime-directory.ts";
import { check, withDoctor, type DoctorScene } from "./doctor-fixture.ts";

function runtime(scene: DoctorScene) {
  const path = runtimeDirectory(scene.environment, scene.repository);
  assert.ok(path);
  return path;
}

await test("CLV-207 absent runtime folders are checked through their nearest existing parents", () =>
  withDoctor(async (scene) => {
    const output = await scene.report();
    assert.equal(check(output, "runtime-directory")["result"], "ok");
    assert.equal(check(output, "service")["result"], "skip");
    assert.match(
      String(check(output, "runtime-directory")["detail"]),
      /socket.*bytes.*owner.*mode/i,
    );
  }));

await test("CLV-207 private runtime permissions and owner are required", () =>
  withDoctor(async (scene) => {
    const path = runtime(scene);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o755);
    assert.equal(
      check(await scene.report(), "runtime-directory")["result"],
      "fail",
    );
    await chmod(path, 0o700);
    const hook = join(scene.root, "other-owner.mjs");
    await writeFile(
      hook,
      "const uid = process.getuid(); process.getuid = () => uid + 1;",
    );
    const output = await scene.report({
      NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`,
    });
    assert.equal(check(output, "runtime-directory")["result"], "fail");
    assert.match(
      String(check(output, "runtime-directory")["detail"]),
      /owner/i,
    );
  }));

await test("CLV-207 writable runtime in an unwritable parent fails", () =>
  withDoctor(async (scene) => {
    const path = runtime(scene);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o500);
    try {
      assert.equal(
        check(await scene.report(), "runtime-directory")["result"],
        "fail",
      );
    } finally {
      await chmod(dirname(path), 0o700);
    }
  }));

for (const folder of [
  "project",
  "workflow-bundles",
  "state",
  "world",
  "journal",
  "worktrees",
  "github",
  "handoffs",
])
  await test(`CLV-207 unwritable ${folder} sibling fails even when its parent is writable`, () =>
    withDoctor(async (scene) => {
      const path = join(dirname(runtime(scene)), folder);
      await mkdir(dirname(path), { recursive: true });
      await mkdir(path, { mode: 0o500 });
      try {
        assert.equal(
          check(await scene.report(), "runtime-directory")["result"],
          "fail",
        );
      } finally {
        await chmod(path, 0o700);
      }
    }));

await test("CLV-207 adoption record folder must be writable", () =>
  withDoctor(async (scene) => {
    const record = adoptionRecordPath(scene.environment, scene.repository);
    assert.ok(record);
    const path = join(scene.root, "legacy/run");
    await mkdir(path, { recursive: true, mode: 0o700 });
    await mkdir(dirname(record), { recursive: true });
    await writeFile(
      record,
      JSON.stringify({
        schemaVersion: 1,
        repository: scene.repository,
        runtimeDirectory: path,
      }),
    );
    await chmod(dirname(record), 0o500);
    try {
      assert.equal(
        check(await scene.report(), "runtime-directory")["result"],
        "fail",
      );
    } finally {
      await chmod(dirname(record), 0o700);
    }
  }));

async function withSocket(
  options: { readonly scene: DoctorScene; readonly answer: "reply" | "silent" },
  use: (path: string) => Promise<void>,
) {
  const { scene, answer } = options;
  const path = join(scene.root, "long".repeat(30), "run");
  const project = join(dirname(path), "project");
  await mkdir(path, { recursive: true, mode: 0o700 });
  await mkdir(project);
  const prior = process.cwd();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (answer === "reply")
      socket.once("data", () =>
        socket.end(replyLine({ kind: "result", result: { runs: [] } })),
      );
  });
  try {
    process.chdir(project);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen("../run/control.sock", resolve);
    });
  } finally {
    process.chdir(prior);
  }
  try {
    await use(path);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
}

await test("CLV-207 long absolute sockets pass and answer from a distant folder through the generated project", () =>
  withDoctor((scene) =>
    withSocket({ scene, answer: "reply" }, async (path) => {
      assert.ok(Buffer.byteLength(join(path, "control.sock")) > 103);
      const output = await scene.report({ CLOVING_RUNTIME_DIR: path });
      assert.equal(check(output, "runtime-directory")["result"], "ok");
      assert.equal(check(output, "service")["result"], "ok");
    }),
  ));

await test("CLV-207 a socket that does not answer fails after five seconds", () =>
  withDoctor((scene) =>
    withSocket({ scene, answer: "silent" }, async (path) => {
      const started = performance.now();
      const output = await scene.report({ CLOVING_RUNTIME_DIR: path });
      assert.equal(check(output, "service")["result"], "fail");
      assert.ok(performance.now() - started >= 5000);
      assert.ok(performance.now() - started < 9000);
    }),
  ));

await test("CLV-207 the read-only service adapter rejects a missing runtime", () => {
  const result = spawnSync(
    process.execPath,
    [resolve("src/cli/doctor-service.ts")],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

await test("CLV-207 runtime socket length uses the physical service start folder through symbolic parents", () =>
  withDoctor(async (scene) => {
    const physical = join(scene.root, "physical");
    const alias = join(scene.root, "alias".repeat(30));
    await mkdir(join(physical, "run"), { recursive: true, mode: 0o700 });
    await mkdir(join(physical, "project"));
    await symlink(physical, alias);
    const cwd = spawnSync(process.execPath, ["-p", "process.cwd()"], {
      cwd: join(alias, "project"),
      encoding: "utf8",
    });
    assert.equal(cwd.stdout.trim(), join(physical, "project"));
    const output = await scene.report({
      CLOVING_RUNTIME_DIR: join(alias, "run"),
    });
    assert.equal(check(output, "runtime-directory")["result"], "fail");
    assert.match(
      String(check(output, "runtime-directory")["detail"]),
      /103 bytes/,
    );
  }));
