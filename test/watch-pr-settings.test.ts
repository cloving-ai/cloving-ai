import assert from "node:assert/strict";
import { test } from "node:test";
import { watchPrObserver } from "../src/cli/watch-pr-settings.ts";
import { prOutput, recordedPr, settleObservation } from "./watch-pr-fixture.ts";
import type { WatchCommandRequest } from "../src/cli/watch-pr-command.ts";

await test("CLV-093 watch parses configured command and reads only the service repository local origin", async () => {
  for (const configured of [undefined, '["fake-gh","prefix with spaces"]']) {
    const requests: WatchCommandRequest[] = [];
    const observer = await watchPrObserver({
      repository: "service-repository",
      githubCommand: configured,
      execute: (request) => {
        requests.push(request);
        return Promise.resolve(
          request.command[0] === "git"
            ? {
                stdout: "git@github.example:fixture/demo.git\n",
                stderr: "",
                status: 0,
                errorCode: null,
              }
            : prOutput(true),
        );
      },
    });
    try {
      assert.equal(observer.observe(recordedPr), null);
      await settleObservation();
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[0]?.command, [
        "git",
        "config",
        "--local",
        "--get-all",
        "remote.origin.url",
      ]);
      assert.equal(requests[0].directory, "service-repository");
      assert.deepEqual(
        requests[1]?.command.slice(0, -7),
        configured === undefined ? ["gh"] : ["fake-gh", "prefix with spaces"],
      );
      assert.equal(requests[1].directory, "service-repository");
      assert.deepEqual(observer.observe(recordedPr), { status: "merged" });
    } finally {
      observer.close();
    }
  }
});

await test("CLV-093 absent service context, ambiguous origins and invalid commands make no GitHub call", async () => {
  for (const [repository, githubCommand, origin] of [
    [undefined, undefined, "git@github.example:fixture/demo.git"],
    ["service-repository", "not json", "git@github.example:fixture/demo.git"],
    ["service-repository", "[]", "git@github.example:fixture/demo.git"],
    ["service-repository", '["gh",3]', "git@github.example:fixture/demo.git"],
    ["service-repository", undefined, ""],
    [
      "service-repository",
      undefined,
      "git@github.example:fixture/demo.git\ngit@github.example:other/demo.git",
    ],
  ] as const) {
    const calls: string[] = [];
    const observer = await watchPrObserver({
      repository,
      githubCommand,
      execute: (request) => {
        calls.push(String(request.command[0]));
        return Promise.resolve({
          stdout: origin,
          stderr: "",
          status: 0,
          errorCode: null,
        });
      },
    });
    try {
      assert.deepEqual(observer.observe(recordedPr), {
        status: "unavailable",
        failure: "configuration",
      });
      await settleObservation();
      assert.ok(calls.every((command) => command === "git"));
    } finally {
      observer.close();
    }
  }
});

await test("CLV-093 a failed local origin read gives configuration status without a GitHub call", async () => {
  const requests: WatchCommandRequest[] = [];
  const observer = await watchPrObserver({
    repository: "service-repository",
    githubCommand: undefined,
    execute: (request) => {
      requests.push(request);
      return Promise.reject(new Error("private origin command failure"));
    },
  });
  try {
    assert.deepEqual(observer.observe(recordedPr), {
      status: "unavailable",
      failure: "configuration",
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.command[0], "git");
  } finally {
    observer.close();
  }
});

await test("CLV-093 missing or unusable local git tooling is command failure without a GitHub read", async () => {
  for (const errorCode of ["ENOENT", "EACCES"]) {
    const requests: WatchCommandRequest[] = [];
    const observer = await watchPrObserver({
      repository: "service-repository",
      githubCommand: undefined,
      execute: (request) => {
        requests.push(request);
        return Promise.resolve({
          stdout: "",
          stderr: "private tooling failure",
          status: null,
          errorCode,
        });
      },
    });
    try {
      assert.deepEqual(observer.observe(recordedPr), {
        status: "unavailable",
        failure: "command",
      });
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.command[0], "git");
    } finally {
      observer.close();
    }
  }
});
