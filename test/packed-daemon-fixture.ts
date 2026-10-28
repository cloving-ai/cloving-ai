import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stopChildGroup } from "./stop-child.ts";
import { packedNotifyCommand } from "./packed-decision-wait.ts";
import { boundedExit, ready, startPackedHost } from "./packed-host-fixture.ts";
import type { OperatorDaemon } from "./operator-restart-fixture.ts";

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
    CLOVING_NOTIFY_COMMAND: packedNotifyCommand(root),
    CLOVING_NEXT_COMMAND: "[]",
    CLOVING_TICKET_COMMAND: "[]",
    CLOVING_CHECK_COMMAND: "[]",
    CLOVING_COMMANDS: JSON.stringify({
      "approval-status": [process.execPath, join(root, "approval-status.cjs")],
    }),
    CLOVING_COMMAND_SECONDS: "10",
  };
}

export async function packedDaemon(
  root: string,
  settings: { readonly executable: string; readonly env: NodeJS.ProcessEnv },
): Promise<OperatorDaemon> {
  const { child, closed, output } = startPackedHost({ root, ...settings });
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
