import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { signal } from "./claude-profiles-fixture.ts";
import {
  alive,
  intent,
  until,
  withScene,
  type Scene,
} from "./claude-worker-fixture.ts";

function leaving(scene: Scene): readonly string[] {
  const script = join(scene.directory, "leaving-worker.mjs");
  const child = join(scene.directory, "left-child.pid");
  writeFileSync(
    script,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
for await (const chunk of process.stdin) String(chunk);
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000);"], { detached: true, stdio: "ignore" });
child.unref();
writeFileSync(${JSON.stringify(child)}, String(child.pid));
console.log(JSON.stringify({ type: "result", is_error: false, result: "done" }));
`,
  );
  return [process.execPath, script];
}

await test("CLV-310 a turn end stops a child in the work tree that ignores SIGTERM and logs it", () =>
  withScene(async (scene) => {
    const lines: string[] = [];
    const worker = scene.worker("bare", {
      command: leaving(scene),
      log: (line) => {
        lines.push(line);
      },
    });
    await worker.deliver(intent({ method: "run-turn" }), signal);
    await until(() => scene.reports.length === 1);
    const child = Number(
      readFileSync(join(scene.directory, "left-child.pid"), "utf8"),
    );
    try {
      assert.equal(scene.reports[0]?.outcome, "completed");
      assert.equal(alive(child), false);
      assert.equal(lines.length, 1, lines.join(""));
      assert.match(
        lines[0] ?? "",
        new RegExp(
          `^turn: stopped process ${String(child)} \\(.*node.*\\) left in the work tree ${scene.worktrees}/ticket-one\\n$`,
        ),
      );
    } finally {
      if (alive(child)) process.kill(child, "SIGKILL");
    }
  }));
