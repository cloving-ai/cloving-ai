import assert from "node:assert/strict";
import net from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { configScene } from "./config-cli-fixture.ts";

function queueNotices(
  fixture: ReturnType<typeof configScene>,
  env: Readonly<Record<string, string>>,
): void {
  for (const [field, value] of [
    ["queue.lanes", "2"],
    ["queue.workingLanes", "1"],
    ["queue.maxLoadPerCore", "0.9"],
    ["queue.maxMemoryPressure", "warn"],
  ] as const) {
    const queued = fixture.run(["set", field, value, "--json"], env);
    assert.equal(queued.status, 0, queued.stderr);
    assert.match(queued.stdout, /Run cloving reload to use the new value\./);
  }
}

await test("CLV-206 changes explain restart behavior and higher-priority sources with a running service", async () => {
  using fixture = configScene();
  const server = net.createServer((socket) => socket.destroy());
  const address = join(fixture.root, "control.sock");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, resolve);
  });
  await using listening = {
    [Symbol.asyncDispose]: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
  assert.ok(listening);
  const env = { CLOVING_RUNTIME_DIR: fixture.root };
  const effective = fixture.run(
    ["set", "queue.everySeconds", "20", "--json"],
    env,
  );
  assert.equal(effective.status, 0, effective.stderr);
  assert.match(effective.stdout, /Restart the service to use the new value\./);
  const reloadable = fixture.run(
    ["set", "fallbackModels", '["fallback-model"]', "--json"],
    env,
  );
  assert.equal(reloadable.status, 0, reloadable.stderr);
  assert.match(reloadable.stdout, /Run cloving reload to use the new value\./);
  queueNotices(fixture, env);
  fixture.write(fixture.privateFile, {
    version: 1,
    queue: { everySeconds: 30 },
  });
  const hidden = fixture.run(["set", "queue.everySeconds", "40"], env);
  assert.equal(hidden.status, 0, hidden.stderr);
  assert.match(
    hidden.stdout,
    /private.*restart keeps the value of that source/is,
  );
  const environment = fixture.run(["unset", "queue.everySeconds", "--json"], {
    ...env,
    CLOVING_QUEUE_SECONDS: "50",
  });
  assert.equal(environment.status, 0, environment.stderr);
  assert.match(
    environment.stdout,
    /environment.*restart keeps the value of that source/is,
  );
  const unmasked = fixture.run(
    ["unset", "queue.everySeconds", "--private"],
    env,
  );
  assert.match(unmasked.stdout, /Restart the service to use the new value\./);
});
