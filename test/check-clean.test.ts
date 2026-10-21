import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  gateReady,
  reportingGate,
  withCleanRepository,
} from "./check-clean-fixture.ts";
import { stopChildGroup } from "./stop-child.ts";
import { testMilliseconds } from "./test-timing.ts";

await test("CLV-151 a committed gate passes with ignored build input locally and fails in the clean committed tree", async () => {
  await withCleanRepository(
    reportingGate + 'await import("../test/required-input.test.ts");\n',
    ({ repository, temporary, env }) => {
      mkdirSync(join(repository, "dist"));
      writeFileSync(join(repository, "dist/required-input.txt"), "stale build");
      const local = spawnSync(process.execPath, ["tools/check-quality.ts"], {
        cwd: repository,
        env,
        encoding: "utf8",
      });
      assert.equal(local.status, 0, local.stderr);
      const clean = spawnSync("npm", ["run", "check:clean"], {
        cwd: repository,
        env,
        encoding: "utf8",
      });
      assert.equal(clean.status, 1);
      assert.match(
        clean.stdout + clean.stderr,
        /ENOENT.*dist\/required-input\.txt/,
      );
      assert.match(clean.stdout, /copied dependency/);
      assert.match(clean.stdout, /clean-copy=.*cloving-check-clean-/);
      assert.equal(
        readFileSync(join(repository, "dist/required-input.txt"), "utf8"),
        "stale build",
      );
      assert.deepEqual(readdirSync(temporary), []);
    },
  );
});

for (const change of ["unstaged", "staged", "untracked"]) {
  await test(`CLV-151 ${change} changes refuse before temporary allocation or dependency copying`, async () => {
    await withCleanRepository(
      reportingGate,
      ({ repository, temporary, env }) => {
        const file =
          change === "untracked" ? "extra.txt" : "tools/check-quality.ts";
        writeFileSync(join(repository, file), "changed\n");
        if (change === "staged") {
          execFileSync("git", ["add", file], { cwd: repository });
        }
        rmSync(join(repository, "node_modules"), { recursive: true });
        const clean = spawnSync("npm", ["run", "check:clean"], {
          cwd: repository,
          env: { ...env, TMPDIR: join(temporary, "missing") },
          encoding: "utf8",
        });
        assert.equal(clean.status, 1);
        assert.match(clean.stderr, /uncommitted changes.*commit/is);
        assert.doesNotMatch(clean.stderr, /ENOENT/);
        assert.deepEqual(readdirSync(temporary), []);
      },
    );
  });
}

for (const code of [0, 37]) {
  await test(`CLV-151 the clean gate preserves environment and exit ${String(code)}, and removes the copy`, async () => {
    await withCleanRepository(
      reportingGate +
        `console.log(process.env["CLEAN_GATE_PROBE"]); process.exitCode = ${String(code)};`,
      ({ repository, temporary, env }) => {
        const clean = spawnSync("npm", ["run", "check:clean"], {
          cwd: repository,
          env: { ...env, CLEAN_GATE_PROBE: "inherited value" },
          encoding: "utf8",
        });
        assert.equal(clean.status, code, clean.stderr);
        assert.match(clean.stdout, /copied dependency\ninherited value/);
        assert.deepEqual(readdirSync(temporary), []);
      },
    );
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  for (const target of ["wrapper", "gate"]) {
    await test(
      `CLV-151 ${signal} interruption of the ${target} removes the clean copy`,
      { timeout: testMilliseconds(15000) },
      async () => {
        await withCleanRepository(
          reportingGate +
            'setInterval(() => {}, 1000); console.log("gate-ready=" + process.pid);',
          async ({ repository, temporary, env }) => {
            const child = spawn(process.execPath, ["tools/check-clean.ts"], {
              cwd: repository,
              env,
              detached: true,
              stdio: ["ignore", "pipe", "pipe"],
            });
            try {
              const gate = await gateReady(child);
              const exited = once(child, "exit");
              process.kill(
                target === "wrapper" ? Number(child.pid) : gate,
                signal,
              );
              const result = await exited;
              assert.deepEqual(readdirSync(temporary), []);
              assert.deepEqual(result, [signal === "SIGINT" ? 130 : 143, null]);
            } finally {
              await stopChildGroup(child);
            }
          },
        );
      },
    );
  }
}
