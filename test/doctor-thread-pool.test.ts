import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { check, withDoctor, withServiceSocket } from "./doctor-fixture.ts";

const stalled = {
  result: "stalled",
  checkedAt: "2026-11-05T10:00:00.000Z",
  milliseconds: 5003,
  resources: { FSReqPromise: 3, Timeout: 2 },
};
const healthy = {
  result: "ok",
  checkedAt: "2026-11-05T10:00:00.000Z",
  milliseconds: 2,
};

async function withHealth(
  threadPool: unknown,
  use: (port: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((request, response) => {
    response.writeHead(request.url === "/health.json" ? 200 : 404, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ threadPool }));
  });
  await new Promise<void>((settle) => {
    server.listen(0, "127.0.0.1", settle);
  });
  try {
    await use(String(Reflect.get(Object(server.address()), "port")));
  } finally {
    server.closeAllConnections();
    await new Promise((settle) => server.close(settle));
  }
}

await test("CLV-298 doctor reports a failed pool check of the daemon", () =>
  withDoctor((scene) =>
    withServiceSocket(
      { scene, answer: { runs: [], threadPool: stalled } },
      (path) =>
        withHealth(healthy, async (port) => {
          const output = await scene.report({
            CLOVING_RUNTIME_DIR: path,
            CLOVING_WATCH_PORT: port,
          });
          const pool = check(output, "thread-pool");
          assert.equal(pool["result"], "fail");
          assert.equal(pool["required"], false);
          assert.equal(
            pool["detail"],
            "Daemon: stalled; the check at 2026-11-05T10:00:00.000Z had no answer after 5003 ms; resources FSReqPromise:3,Timeout:2. Watch page: ok",
          );
          assert.match(String(pool["fix"]), /cloving start/);
        }),
    ),
  ));

await test("CLV-298 doctor reports a failed pool check of the watch child", () =>
  withDoctor((scene) =>
    withServiceSocket(
      { scene, answer: { runs: [], threadPool: healthy } },
      (path) =>
        withHealth(stalled, async (port) => {
          const output = await scene.report({
            CLOVING_RUNTIME_DIR: path,
            CLOVING_WATCH_PORT: port,
          });
          const pool = check(output, "thread-pool");
          assert.equal(pool["result"], "fail");
          assert.equal(
            pool["detail"],
            "Daemon: ok. Watch page: stalled; the check at 2026-11-05T10:00:00.000Z had no answer after 5003 ms; resources FSReqPromise:3,Timeout:2",
          );
        }),
    ),
  ));

await test("CLV-298 doctor passes the pool check when both processes have no failed check", () =>
  withDoctor((scene) =>
    withServiceSocket({ scene, answer: { runs: [] } }, (path) =>
      withHealth(null, async (port) => {
        const pool = check(
          await scene.report({
            CLOVING_RUNTIME_DIR: path,
            CLOVING_WATCH_PORT: port,
          }),
          "thread-pool",
        );
        assert.equal(pool["result"], "ok");
        assert.equal(
          pool["detail"],
          "Daemon: no check yet. Watch page: no check yet",
        );
      }),
    ),
  ));

await test("CLV-298 doctor warns when the watch page of a running service does not answer, and skips it when it is off", () =>
  withDoctor((scene) =>
    withServiceSocket(
      { scene, answer: { runs: [], threadPool: healthy } },
      async (path) => {
        let free = "";
        await withHealth(null, (port) => {
          free = port;
          return Promise.resolve();
        });
        const silent = check(
          await scene.report({
            CLOVING_RUNTIME_DIR: path,
            CLOVING_WATCH_PORT: free,
          }),
          "thread-pool",
        );
        assert.equal(silent["result"], "warn");
        assert.equal(
          silent["detail"],
          `Daemon: ok. Watch page: no answer on port ${free}`,
        );
        const off = check(
          await scene.report({
            CLOVING_RUNTIME_DIR: path,
            CLOVING_WATCH_PORT: "off",
          }),
          "thread-pool",
        );
        assert.equal(off["result"], "ok");
        const invalid = check(
          await scene.report({
            CLOVING_RUNTIME_DIR: path,
            CLOVING_WATCH_PORT: "70000",
          }),
          "thread-pool",
        );
        assert.equal(invalid["result"], "warn");
        assert.equal(
          invalid["detail"],
          "Daemon: ok. Watch page: no answer on port 70000",
        );
        assert.equal(off["detail"], "Daemon: ok. Watch page: off");
      },
    ),
  ));

await test("CLV-298 doctor skips the pool check when no service runs", () =>
  withDoctor(async (scene) => {
    const pool = check(await scene.report(), "thread-pool");
    assert.equal(pool["result"], "skip");
    assert.equal(pool["detail"], "Service prerequisite unavailable");
  }));
