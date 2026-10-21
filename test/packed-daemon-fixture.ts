import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stopChildGroup } from "./stop-child.ts";
import type { OperatorDaemon } from "./operator-restart-fixture.ts";

async function ready(
  child: ChildProcess,
  output: { text: string },
): Promise<string> {
  for (let count = 0; count < 1500; count += 1) {
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

function boundedExit(closed: Promise<number | null>): Promise<number | null> {
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
        reject(new Error("Installed startup failed", { cause: error }));
      },
    );
  });
}

export async function packedEnvironment(
  root: string,
): Promise<NodeJS.ProcessEnv> {
  await writeFile(
    join(root, "fake-worker.mjs"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(root, "worker-called"))}, "called"); process.exit(1);`,
  );
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          !name.startsWith("CLOVING_") &&
          name !== "NODE_OPTIONS" &&
          name !== "NODE_PATH",
      ),
    ),
    NODE_OPTIONS: "--no-strip-types",
    XDG_CONFIG_HOME: join(root, "config"),
    CLOVING_RUNTIME_DIR: join(root, "host/run"),
    CLOVING_WATCH_PORT: "0",
    CLOVING_CLAUDE_COMMAND: JSON.stringify([
      process.execPath,
      join(root, "fake-worker.mjs"),
    ]),
    CLOVING_GH_COMMAND: JSON.stringify([
      process.execPath,
      join(root, "fake-worker.mjs"),
    ]),
    CLOVING_NOTIFY_COMMAND: "[]",
    CLOVING_NEXT_COMMAND: "[]",
    CLOVING_TICKET_COMMAND: "[]",
    CLOVING_CHECK_COMMAND: "[]",
  };
}

export async function packedDaemon(
  root: string,
  settings: { readonly executable: string; readonly env: NodeJS.ProcessEnv },
): Promise<OperatorDaemon> {
  const { executable, env } = settings;
  const child = spawn(executable, ["start"], {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<number | null>((settle) =>
    child.once("close", settle),
  );
  const output = { text: "" };
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes: Buffer) => {
      output.text += bytes.toString();
    });
  try {
    const address = await ready(child, output);
    return {
      address,
      stop: async () => {
        try {
          child.kill("SIGTERM");
          assert.equal(await boundedExit(closed), 0);
          assert.throws(() => process.kill(-Number(child.pid), 0), {
            code: "ESRCH",
          });
        } finally {
          await stopChildGroup(child);
        }
      },
    };
  } catch (error) {
    await stopChildGroup(child);
    throw error;
  }
}
