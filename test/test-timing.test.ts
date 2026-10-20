import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { testMilliseconds } from "./test-timing.ts";

await test("CLV-147 test durations follow the check time factor and reject invalid factors", () => {
  const previous = process.env["CLOVING_CHECK_TIME_FACTOR"];
  try {
    delete process.env["CLOVING_CHECK_TIME_FACTOR"];
    assert.equal(testMilliseconds(200), 200);
    process.env["CLOVING_CHECK_TIME_FACTOR"] = "3";
    assert.equal(testMilliseconds(200), 600);
    for (const factor of ["0", "6", "1.5", "invalid", ""]) {
      process.env["CLOVING_CHECK_TIME_FACTOR"] = factor;
      assert.throws(() => testMilliseconds(200), {
        message: "CLOVING_CHECK_TIME_FACTOR must be a whole number from 1 to 5",
      });
    }
  } finally {
    if (previous === undefined) delete process.env["CLOVING_CHECK_TIME_FACTOR"];
    else process.env["CLOVING_CHECK_TIME_FACTOR"] = previous;
  }
});

await test("CLV-147 shared service and recovery timings scale with the authority", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { testTiming } from "./test/service-fixture.ts"; import { steady } from "./test/stop-opening-fixture.ts"; process.stdout.write(JSON.stringify({ service: { ...testTiming, authority: undefined }, lease: steady.timing.leaseMilliseconds, renewal: steady.timing.renewalMilliseconds, callTimeout: steady.timing.callTimeoutMilliseconds }));',
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CLOVING_CHECK_TIME_FACTOR: "3" },
    },
  );
  assert.deepEqual(JSON.parse(output), {
    service: {
      expiryScanMilliseconds: 150,
      livenessMilliseconds: 1_800_000,
      followMilliseconds: 60,
      resolverMilliseconds: 90_000,
      idleMilliseconds: 90_000,
    },
    lease: 6_000,
    renewal: 1_500,
    callTimeout: 30_000,
  });
});

await test("CLV-147 shared authority timings scale every duration with the check time factor", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { fastTiming, quickCleanupTiming } from "./test/authority-store-fixture.ts"; process.stdout.write(JSON.stringify({ fastTiming, quickCleanupTiming }));',
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CLOVING_CHECK_TIME_FACTOR: "3" },
    },
  );
  const retention = {
    messageRetentionMilliseconds: 7_776_000_000,
    retentionIntervalMilliseconds: 10_800_000,
    shutdownMilliseconds: 30_000,
  };
  const cleanup = {
    ...retention,
    heartbeatMilliseconds: 300,
    aliveThresholdMilliseconds: 900,
    cleanupIntervalMilliseconds: 300,
  };
  assert.deepEqual(JSON.parse(output), {
    quickCleanupTiming: {
      ...cleanup,
      leaseMilliseconds: 6_000,
      renewalMilliseconds: 1_500,
      callTimeoutMilliseconds: 30_000,
    },
    fastTiming: {
      ...cleanup,
      leaseMilliseconds: 600,
      renewalMilliseconds: 150,
      callTimeoutMilliseconds: 6_000,
    },
  });
});
