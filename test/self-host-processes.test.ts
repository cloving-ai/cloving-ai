import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, test } from "node:test";
import { hostProcesses } from "../tools/self-host-processes.ts";
import { updateFixture } from "./self-update-fixture.ts";

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
});

async function child(mode = "immediate"): Promise<ChildProcess> {
  const processChild = spawn(
    process.execPath,
    [
      "-e",
      `
process.stdin.resume();
process.on("SIGTERM", () => {
  process.stdout.write("stopping");
  if (${JSON.stringify(mode)} === "immediate") process.exit(0);
  process.stdin.once("data", () => process.exit(0));
});
process.stdout.write("ready");
`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(processChild);
  await new Promise<void>((settle) =>
    processChild.stdout.once("data", () => {
      settle();
    }),
  );
  return processChild;
}

await test("CLV-085 shutdown waits for the daemon and watch page before fast-forwarding", async () => {
  const daemon = await child();
  const watch = await child("drain");
  const fixture = updateFixture();
  const stopping = new Promise<void>((settle) =>
    watch.stdout?.once("data", () => {
      settle();
    }),
  );
  const running = hostProcesses({
    daemon,
    watch,
    update: { milliseconds: 1, settings: fixture.settings },
  });
  const first = await Promise.race([
    stopping.then(() => "stopping"),
    running.then(() => "ended"),
  ]);
  assert.equal(first, "stopping");
  assert.equal(
    fixture.calls.some((call) => call.startsWith("merge --")),
    false,
  );
  watch.stdin?.write("end");
  assert.equal(await running, 75);
  assert.equal(daemon.exitCode, 0);
  assert.equal(watch.exitCode, 0);
  assert.equal(
    fixture.calls.at(-1),
    "merge --ff-only --no-overwrite-ignore after",
  );
});

await test("CLV-085 without an interval the host waits for the daemon and closes the watch page", async () => {
  const daemon = await child();
  const watch = await child();
  const running = hostProcesses({ daemon, watch });
  daemon.kill("SIGTERM");
  assert.equal(await running, 0);
  assert.equal(watch.exitCode, 0);
});

await test("CLV-085 an operator interrupt during update shutdown prevents merge and restart", async () => {
  const daemon = await child();
  const watch = await child("drain");
  const fixture = updateFixture();
  const stopping = new Promise<void>((settle) =>
    watch.stdout?.once("data", () => {
      settle();
    }),
  );
  const running = hostProcesses({
    daemon,
    watch,
    update: { milliseconds: 1, settings: fixture.settings },
  });
  await stopping;
  process.emit("SIGINT");
  assert.notEqual(await running, 75);
  assert.equal(
    fixture.calls.some((call) => call.startsWith("merge --")),
    false,
  );
});

await test("CLV-085 a failed update whose target cannot be recorded exits with an error", async () => {
  const daemon = await child();
  const fixture = updateFixture();
  fixture.replies.delete("merge --ff-only --no-overwrite-ignore after");
  const settings = {
    ...fixture.settings,
    recordFailure: () => Promise.reject(new Error("ENOSPC")),
  };
  assert.equal(
    await hostProcesses({
      daemon,
      watch: undefined,
      update: { milliseconds: 1, settings },
    }),
    1,
  );
  const errors = fixture.calls.filter((call) => call.startsWith("error: "));
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /merge.*ENOSPC/);
});
