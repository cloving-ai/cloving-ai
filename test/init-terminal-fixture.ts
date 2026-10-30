import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import type { DoctorScene } from "./doctor-fixture.ts";
import { stopChildGroup } from "./stop-child.ts";

const terminalBridge = `
import errno, os, pty, select, sys
child, terminal = pty.fork()
if child == 0:
    os.execv(sys.argv[1], sys.argv[1:])
while True:
    ready, _, _ = select.select([terminal, 0], [], [])
    try:
        if terminal in ready:
            data = os.read(terminal, 65536)
            if not data: break
            os.write(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if data: os.write(terminal, data)
    except OSError as error:
        if error.errno == errno.EIO: break
        raise
_, status = os.waitpid(child, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

export async function terminalInit(scene: DoctorScene) {
  const child = spawn(
    "/usr/bin/python3",
    ["-c", terminalBridge, process.execPath, resolve("src/cli.ts"), "init"],
    {
      cwd: scene.repository,
      env: { ...scene.environment, SHELL: "/bin/sh", TERM: "xterm" },
      detached: true,
    },
  );
  const output = { stdout: "", stderr: "", selected: false, answered: false };
  child.stdout.on("data", (data: Buffer) => {
    output.stdout += data.toString();
    if (!output.selected && output.stdout.includes("for the setup?")) {
      output.selected = true;
      child.stdin.write("\n");
    }
    if (!output.answered && output.stdout.includes("harness-question: ")) {
      output.answered = true;
      child.stdin.write("hello harness\n");
    }
  });
  child.stderr.on("data", (data: Buffer) => {
    output.stderr += data.toString();
  });
  try {
    const ended = await once(child, "close", {
      signal: AbortSignal.timeout(15000),
    });
    return { ended, ...output };
  } finally {
    await stopChildGroup(child, { graceMilliseconds: 50 });
  }
}
