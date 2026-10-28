import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { testMilliseconds } from "./test-timing.ts";

export function startPackedHost(settings: {
  readonly root: string;
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
}) {
  const child = spawn(settings.executable, ["start"], {
    cwd: settings.root,
    env: settings.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { text: "" };
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes: Buffer) => {
      output.text += bytes.toString();
    });
  const closed = new Promise<number | null>((settle) =>
    child.once("close", settle),
  );
  return { child, output, closed };
}

export async function ready(
  child: ChildProcess,
  output: { readonly text: string },
): Promise<string> {
  for (let count = 0; count < testMilliseconds(30_000) / 20; count += 1) {
    assert.equal(
      child.exitCode,
      null,
      `Installed startup exited: ${output.text}`,
    );
    assert.equal(child.signalCode, null, output.text);
    const address = /Watch page: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(
      output.text,
    )?.[1];
    if (output.text.includes("Cloving runs") && address !== undefined)
      return address;
    await delay(20);
  }
  throw new Error(`Installed startup did not become ready: ${output.text}`);
}

export function boundedExit(
  closed: Promise<number | null>,
): Promise<number | null> {
  return new Promise((settle, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Installed startup did not stop"));
    }, 10000);
    closed.then(
      (status) => {
        clearTimeout(timer);
        settle(status);
      },
      (error: unknown) => {
        clearTimeout(timer);
        const cause = error instanceof Error ? error : undefined;
        reject(new Error("Installed startup failed", { cause }));
      },
    );
  });
}
