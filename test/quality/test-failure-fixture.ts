import assert from "node:assert/strict";
import { readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

export async function failedOutput(
  operation: () => void | Promise<void>,
): Promise<{
  readonly output: string;
  readonly error: Error;
}> {
  let output = "";
  let failure: unknown;
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      async () => {
        await operation();
      },
      (error: unknown) => {
        failure = error;
        return true;
      },
    );
  } finally {
    process.stderr.write = write;
  }
  assert.ok(failure instanceof Error);
  return { output, error: failure };
}

export function retainedReport(error: unknown): string {
  assert.ok(error instanceof Error);
  assert.ok(error.message.length < 2000);
  const path = /Full test report: (.+)/.exec(error.message)?.[1];
  assert.ok(path);
  try {
    assert.equal(dirname(path), tmpdir());
    assert.equal(statSync(path).mode & 0o777, 0o600);
    return readFileSync(path, "utf8");
  } finally {
    rmSync(path);
  }
}
