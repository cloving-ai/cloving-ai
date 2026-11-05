import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { threadPoolObservation } from "../src/cli/doctor-thread-pool.ts";
import { check, withDoctor, withServiceSocket } from "./doctor-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

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

function withHealth(
  threadPool: unknown,
  use: (port: string) => Promise<void>,
): Promise<void> {
  return withHealthServer((request, response) => {
    response.writeHead(request.url === "/health.json" ? 200 : 404, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ threadPool }));
  }, use);
}

async function withHealthServer(
  listener: RequestListener,
  use: (port: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(listener);
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

async function bounded<Value>(
  pending: Promise<Value>,
  milliseconds: number,
): Promise<Value | "no end"> {
  return Promise.race([
    pending,
    delay(testMilliseconds(milliseconds)).then(() => "no end" as const),
  ]);
}

await test("CLV-298 doctor warns and ends when the watch page closes the connection in the middle of the health reply", () =>
  withDoctor((scene) =>
    withServiceSocket(
      { scene, answer: { runs: [], threadPool: healthy } },
      (path) =>
        withHealthServer(
          (_request, response) => {
            response.writeHead(200, {
              "content-type": "application/json",
              "content-length": "1000",
            });
            response.write('{"threadPool":', () => {
              response.socket?.destroy();
            });
          },
          async (port) => {
            const output = await bounded(
              scene.report({
                CLOVING_RUNTIME_DIR: path,
                CLOVING_WATCH_PORT: port,
              }),
              3000,
            );
            assert.ok(output !== "no end");
            const pool = check(output, "thread-pool");
            assert.equal(pool["result"], "warn");
            assert.equal(
              pool["detail"],
              `Daemon: ok. Watch page: no answer on port ${port}`,
            );
          },
        ),
    ),
  ));

await test("CLV-298 doctor stops the health request at its deadline when the watch page sends the reply slowly and never ends it", () => {
  const healthMilliseconds = 200;
  const closed = Promise.withResolvers<undefined>();
  return withHealthServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      const timer = setInterval(() => response.write(" "), 20);
      response.on("close", () => {
        clearInterval(timer);
        closed.resolve(undefined);
      });
    },
    async (port) => {
      const started = performance.now();
      const observation = await bounded(
        threadPoolObservation(
          { threadPool: healthy },
          {
            environment: { CLOVING_WATCH_PORT: port },
            healthMilliseconds,
          },
        ),
        3000,
      );
      assert.deepEqual(observation, {
        result: "warn",
        detail: `Daemon: ok. Watch page: no answer on port ${port}`,
      });
      assert.ok(performance.now() - started >= healthMilliseconds - 20);
      assert.equal(await bounded(closed.promise, 3000), undefined);
    },
  );
});

await test("CLV-298 doctor skips the pool check when no service runs", () =>
  withDoctor(async (scene) => {
    const pool = check(await scene.report(), "thread-pool");
    assert.equal(pool["result"], "skip");
    assert.equal(pool["detail"], "Service prerequisite unavailable");
  }));
