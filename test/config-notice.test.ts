import assert from "node:assert/strict";
import net from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { configScene } from "./config-cli-fixture.ts";

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
  const effective = fixture.run(["set", "queue.lanes", "2", "--json"], env);
  assert.equal(effective.status, 0, effective.stderr);
  assert.match(effective.stdout, /Restart the service to use the new value\./);
  fixture.write(fixture.privateFile, { version: 1, queue: { lanes: 3 } });
  const hidden = fixture.run(["set", "queue.lanes", "1"], env);
  assert.equal(hidden.status, 0, hidden.stderr);
  assert.match(
    hidden.stdout,
    /private.*restart keeps the value of that source/is,
  );
  const environment = fixture.run(["unset", "queue.lanes", "--json"], {
    ...env,
    CLOVING_QUEUE_LANES: "4",
  });
  assert.equal(environment.status, 0, environment.stderr);
  assert.match(
    environment.stdout,
    /environment.*restart keeps the value of that source/is,
  );
  const unmasked = fixture.run(["unset", "queue.lanes", "--private"], env);
  assert.match(unmasked.stdout, /Restart the service to use the new value\./);
});
