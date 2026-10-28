import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { textOutput } from "../src/daemon/text-output.ts";

async function captured(exitCode: number) {
  const directory = mkdtempSync(join(tmpdir(), "cloving-text-output-"));
  const path = join(directory, "output.log");
  const stdout = "x".repeat(500000) + "\nTicket status: complete\n";
  const stderr = "e".repeat(500000) + "failure end";
  try {
    const child = spawn(process.execPath, [
      "-e",
      'process.stdout.write("x".repeat(500000) + "\\nTicket status: complete\\n"); process.stderr.write("e".repeat(500000) + "failure end"); process.exitCode = Number(process.argv[1]);',
      String(exitCode),
    ]);
    const finish = textOutput(child, {
      output: createWriteStream(path),
      limit: 128,
    });
    const code = await new Promise<number | null>((resolve) => {
      child.once("close", resolve);
    });
    const result = await finish(code);
    assert.equal(readFileSync(path, "utf8"), stdout);
    return { result, stdout, stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

await test("CLV-215 text output retains a bounded stdout tail and the complete activity log", async () => {
  const { result, stdout } = await captured(0);
  assert.equal(result.text, stdout.slice(-128));
  assert.deepEqual(result.ticketStatus, { kind: "complete" });
  assert.equal(result.failed, false);
});

await test("CLV-215 failed text output retains a bounded stderr tail", async () => {
  const { result, stderr } = await captured(7);
  assert.equal(result.text, stderr.slice(-128));
  assert.deepEqual(result.ticketStatus, { kind: "complete" });
  assert.equal(result.failed, true);
});
