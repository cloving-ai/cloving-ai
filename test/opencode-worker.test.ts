import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { usageText, priceText } from "../src/cli/usage-render.ts";
import { intent, resultOf, until, withScene } from "./claude-worker-fixture.ts";
import {
  fakeOpencode,
  opencodeEvents,
  opencodeReport,
} from "./opencode-fixture.ts";

await test("CLV-212 the default opencode harness completes a committed turn with summed step usage", () =>
  withScene(async (scene) => {
    const worker = scene.worker("unused", {
      harness: { name: "opencode", kind: "file", path: fakeOpencode(scene) },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const result = resultOf(scene.reports[0].result);
    assert.equal(result["summary"], opencodeReport);
    assert.deepEqual(result["ticketStatus"], { kind: "complete" });
    assert.equal(result["harness"], "opencode");
    assert.equal(
      priceText(result["costUsd"], result["estimatedCostUsd"]),
      "Price not known",
    );
    assert.deepEqual(result["usage"], {
      input_tokens: 300,
      cache_read_input_tokens: 100,
      output_tokens: 62,
    });
    assert.equal(result["turns"], 2);
    assert.equal(result["sessionId"], "session-1");
    assert.deepEqual(result["uncommitted"], []);
    assert.match(String(result["commits"]), /Add opencode work/);
    const observed = resultOf(
      readFileSync(join(scene.directory, "observed.json"), "utf8"),
    );
    assert.deepEqual(observed["arguments"], [
      "run",
      "--format",
      "json",
      "prompt of sha256:prompt",
    ]);
    assert.equal(observed["stdin"], "");
    assert.equal(observed["directory"], result["worktree"]);
  }));

await test("CLV-212 opencode fails with stderr when the process exits unsuccessfully", () =>
  withScene(async (scene) => {
    const worker = scene.worker("unused", {
      harness: {
        name: "opencode",
        path: fakeOpencode(scene, {
          exitCode: 1,
          stderr: "Provider unavailable.",
        }),
      },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "failed");
    assert.equal(
      resultOf(scene.reports[0].result)["summary"],
      "Provider unavailable.",
    );
  }));

await test("CLV-212 opencode refuses incomplete turns even after a zero exit", async () => {
  for (const events of [[], opencodeEvents.slice(0, 3)]) {
    await withScene(async (scene) => {
      const worker = scene.worker("unused", {
        harness: { name: "opencode", path: fakeOpencode(scene, { events }) },
      });
      await worker.deliver(intent(), new AbortController().signal);
      await until(() => scene.reports.length === 1);
      assert.equal(scene.reports[0]?.outcome, "failed");
      assert.match(
        String(resultOf(scene.reports[0].result)["summary"]),
        /opencode.*stop/,
      );
    });
  }
});

await test("CLV-212 an opencode error event fails a turn despite a final stop", async () => {
  for (const error of [
    { name: "APIError", data: { message: "API failed." } },
    { name: "UnknownError" },
    {},
  ]) {
    await withScene(async (scene) => {
      const worker = scene.worker("unused", {
        harness: {
          name: "opencode",
          path: fakeOpencode(scene, {
            events: [{ type: "error", error }, ...opencodeEvents],
          }),
        },
      });
      await worker.deliver(intent(), new AbortController().signal);
      await until(() => scene.reports.length === 1);
      assert.equal(scene.reports[0]?.outcome, "failed");
      assert.equal(
        resultOf(scene.reports[0].result)["summary"],
        Reflect.get(Object(error["data"]), "message") ??
          error["name"] ??
          "opencode error",
      );
    });
  }
});

await test("CLV-212 opencode allows unattended tools and removes GitHub credentials", () =>
  withScene(async (scene) => {
    const worker = scene.worker("unused", {
      harness: { name: "opencode", path: fakeOpencode(scene) },
      profiles: {
        unattended: {
          env: {
            GH_TOKEN: "test-gh-token",
            GITHUB_TOKEN: "test-github-token",
            GH_ENTERPRISE_TOKEN: "test-enterprise-token",
            GITHUB_ENTERPRISE_TOKEN: "test-github-enterprise-token",
            GH_CONFIG_DIR: "must-be-replaced",
            OPENCODE_PERMISSION: '{"*":"ask"}',
          },
        },
      },
    });
    await worker.deliver(
      intent({ method: "run-turn:unattended" }),
      new AbortController().signal,
    );
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const observed = resultOf(
      readFileSync(join(scene.directory, "observed.json"), "utf8"),
    );
    const environment = resultOf(JSON.stringify(observed["environment"]));
    assert.equal(environment["OPENCODE_PERMISSION"], '{"*":"allow"}');
    assert.equal(typeof environment["GH_CONFIG_DIR"], "string");
    assert.notEqual(environment["GH_CONFIG_DIR"], "must-be-replaced");
    assert.deepEqual(observed["configurationFiles"], []);
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ])
      assert.equal(Object.hasOwn(environment, name), false);
  }));

await test("CLV-212 opencode capacity errors do not retry", () =>
  withScene(async (scene) => {
    const waits: number[] = [];
    const worker = scene.worker("unused", {
      harness: {
        name: "opencode",
        path: fakeOpencode(scene, {
          events: [
            {
              type: "error",
              error: {
                name: "APIError",
                data: {
                  message:
                    "Selected model is at capacity. Please try a different model.",
                },
              },
            },
          ],
        }),
      },
      retryDelay: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.deepEqual(waits, []);
    assert.equal(scene.reports[0]?.outcome, "failed");
    assert.equal(
      resultOf(scene.reports[0].result)["summary"],
      "Selected model is at capacity. Please try a different model.",
    );
  }));

await test("CLV-212 opencode reports unknown usage and price when events omit counts", () =>
  withScene(async (scene) => {
    const events = [
      {
        type: "text",
        part: {
          text: "No counts.\nRemaining:\n- More work.\nTicket status: partial",
        },
      },
      { type: "step_finish", part: { reason: "stop" } },
    ];
    const worker = scene.worker("unused", {
      harness: { name: "opencode", path: fakeOpencode(scene, { events }) },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const result = resultOf(scene.reports[0].result);
    assert.deepEqual(result["ticketStatus"], {
      kind: "partial",
      remaining: ["More work."],
    });
    assert.equal(
      usageText(result["usage"]),
      "Input tokens: Token usage not known · Cache read tokens: Token usage not known · Output tokens: Token usage not known",
    );
    assert.equal(
      priceText(result["costUsd"], result["estimatedCostUsd"]),
      "Price not known",
    );
  }));

await test("CLV-212 opencode estimates the reported model before the configured model", () =>
  withScene(async (scene) => {
    const worker = scene.worker("unused", {
      worker: "opencode",
      command: [
        fakeOpencode(scene, {
          events: [
            { type: "step_start", model: "provider/reported" },
            ...opencodeEvents,
          ],
        }),
        "run",
        "--format",
        "json",
        "-m",
        "provider/configured",
      ],
      tokenPrices: {
        "provider/reported": { input: 2, cachedInput: 0.5, output: 8 },
      },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const result = resultOf(scene.reports[0].result);
    assert.equal(result["model"], "provider/reported");
    assert.equal(result["costUsd"], null);
    assert.ok(Math.abs(Number(result["estimatedCostUsd"]) - 0.001146) < 1e-12);
  }));

await test("CLV-212 opencode uses the configured provider/model when events omit it", () =>
  withScene(async (scene) => {
    const worker = scene.worker("unused", {
      harness: { name: "opencode", path: fakeOpencode(scene) },
      profiles: { selected: { model: "provider/configured" } },
      tokenPrices: {
        "provider/configured": { input: 2, cachedInput: 0.5, output: 8 },
      },
    });
    await worker.deliver(
      intent({ method: "run-turn:selected" }),
      new AbortController().signal,
    );
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const result = resultOf(scene.reports[0].result);
    assert.equal(result["model"], "provider/configured");
    assert.ok(Math.abs(Number(result["estimatedCostUsd"]) - 0.001146) < 1e-12);
  }));
