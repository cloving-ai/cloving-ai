import { fontNames, rawFontStatus, servedFonts } from "./watch-font-fixture.ts";
import { withWatchService, watchReplies } from "./watch-service-fixture.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseInvocation } from "../src/cli/arguments.ts";
import { waitingGate, withHarness } from "./service-fixture.ts";
import { refusedWatch, watchedModel, watching } from "./watch-fixture.ts";

function field(value: unknown, name: string | number): unknown {
  return Reflect.get(Object(value), name);
}

function journal(runtimeDirectory: string, runId: string): void {
  const turn = join(dirname(runtimeDirectory), "journal", "a1b2");
  mkdirSync(turn, { recursive: true });
  const records = join(dirname(runtimeDirectory), "journal");
  for (const [key, started] of [
    ["empty", undefined],
    ["broken", "not json"],
    ["later", JSON.stringify({ startedAt: "2026-10-13T22:00:00.000Z" })],
  ] as const) {
    mkdirSync(join(records, key));
    writeFileSync(join(records, key, "other.txt"), started ?? "");
    writeFileSync(
      join(records, key, started === undefined ? "note.txt" : "started.json"),
      started ?? "",
    );
  }
  writeFileSync(
    join(turn, "started.json"),
    JSON.stringify({
      operationId: JSON.stringify(["cloving-operation", 1, runId, "implement"]),
      target: "clv-016-a6f7ef47",
      startedAt: "2026-10-13T21:26:01.000Z",
    }),
  );
  writeFileSync(
    join(turn, "turn.jsonl"),
    '{"type":"result","result":"Done.","total_cost_usd":0.5}\n',
  );
}

function githubResult(
  runtimeDirectory: string,
  ended: { readonly key: string; readonly result: unknown },
): void {
  writeFileSync(
    join(dirname(runtimeDirectory), "github", ended.key, "result.json"),
    JSON.stringify({
      outcome: "completed",
      result: JSON.stringify(ended.result),
      endedAt: "2026-10-14T10:05:00.000Z",
    }),
  );
}

function githubJournal(runtimeDirectory: string, runId: string): void {
  const records = join(dirname(runtimeDirectory), "github");
  const url = "https://github.com/cloving-ai/cloving-ai/pull/61";
  const operations = [
    ["open-pr", 1, { number: 61, url, commit: "aaa" }],
    ["wait-review", 1, { number: 61, commit: "aaa", score: 4 }],
    ["wait-review", 2, null],
  ] as const;
  for (const [method, round, result] of operations) {
    const key = `${method}-${String(round)}`;
    mkdirSync(join(records, key), { recursive: true });
    const scope = ["cloving-operation", round, runId, "pull-request", method];
    writeFileSync(
      join(records, key, "started.json"),
      JSON.stringify({
        operationId: JSON.stringify(scope),
        method,
        target: "clv-065-1e28b544",
        startedAt: "2026-10-14T10:00:00.000Z",
      }),
    );
    if (result !== null) githubResult(runtimeDirectory, { key, result });
  }
  mkdirSync(join(records, "empty"));
}

async function served(address: string): Promise<void> {
  const page = await fetch(address);
  assert.match(String(page.headers.get("content-type")), /^text\/html/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(await page.text(), /function Page\(/);
  const library = await fetch(`${address}preact.mjs`);
  assert.match(
    String(library.headers.get("content-type")),
    /^text\/javascript/,
  );
  assert.equal(library.headers.get("cache-control"), "no-store");
  assert.equal(
    await library.text(),
    readFileSync(fileURLToPath(import.meta.resolve("preact")), "utf8"),
  );
}

await test("CLV-016 the parser reads the watch command with an optional port, and it refuses an argument, a port that is no port and each other option", () => {
  const words = (line: string): readonly string[] => line.split(" ");
  assert.deepEqual(parseInvocation(words("watch")), {
    kind: "watch",
    port: null,
    json: false,
  });
  assert.deepEqual(parseInvocation(words("watch --port 3663")), {
    kind: "watch",
    port: 3663,
    json: false,
  });
  for (const [code, line] of [
    ["unexpected-argument", "watch run-1"],
    ["invalid-option-value", "watch --port 65536"],
    ["invalid-option-value", "watch --port x"],
    ["unexpected-option", "watch --json"],
  ] as const)
    assert.deepEqual(parseInvocation(words(line)), {
      kind: "usage-error",
      code,
      json: line.includes("--json"),
    });
});

await test("CLV-016 cloving watch serves the page, the Preact file of the installed package and the run data of its service on the loopback address, with the decision commands and the Claude turn of a run, and gives 404 for each other request", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    journal(harness.runtimeDirectory, waiting.runId);
    const watch = await watching(harness.runtimeDirectory);
    try {
      await served(watch.address);
      const data = await fetch(`${watch.address}data.json`);
      assert.equal(data.headers.get("cache-control"), "no-store");
      const first: unknown = await data.json();
      const second: unknown = await (
        await fetch(`${watch.address}data.json?again`)
      ).json();
      const run = field(field(first, "runs"), 0);
      assert.deepEqual(field(second, "runs"), field(first, "runs"));
      assert.deepEqual(
        [field(first, "service"), field(run, "runId"), field(run, "state")],
        ["up", waiting.runId, "waiting_gate"],
      );
      assert.match(
        String(field(field(field(run, "decisions"), 0), "approve")),
        new RegExp(
          `^CLOVING_RUNTIME_DIR=\\S+ cloving approve ${waiting.runId}/design-1 --expected-revision 1 `,
        ),
      );
      const turn = field(field(run, "turns"), 0);
      assert.deepEqual(
        [
          field(field(run, "turns"), "length"),
          field(turn, "costUsd"),
          field(field(run, "phases"), "length"),
        ],
        [1, null, 5],
      );
      assert.match(String(field(turn, "activeAt")), /^\d{4}-\d\d-\d\dT/);
      assert.equal(field(field(run, "events"), "length"), 5);
      assert.equal((await fetch(`${watch.address}journal`)).status, 404);
      const posted = await fetch(`${watch.address}data.json`, {
        method: "POST",
      });
      assert.equal(posted.status, 404);
      const busy = await refusedWatch(
        harness.runtimeDirectory,
        new URL(watch.address).port,
      );
      assert.equal(busy.status, 1);
      assert.match(busy.output, /^watch-not-started: /);
    } finally {
      assert.equal(await watch.stop(), 0);
    }
    await service.close();
  }));

async function pullRequestData(address: string): Promise<unknown> {
  const model: unknown = await (await fetch(`${address}data.json`)).json();
  const run = field(field(model, "runs"), 0);
  return [field(run, "pullRequest"), field(run, "reviews")];
}

await test("CLV-065 cloving watch reads the records of the GitHub journal in the host directory and gives a run its pull request link and the scores of its completed reviews, and it reads a finished record one time and a record in work again at each request", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-65",
      kind: "approval",
    });
    githubJournal(harness.runtimeDirectory, waiting.runId);
    const pullRequest = {
      number: 61,
      url: "https://github.com/cloving-ai/cloving-ai/pull/61",
    };
    const watch = await watching(harness.runtimeDirectory);
    try {
      assert.deepEqual(await pullRequestData(watch.address), [
        pullRequest,
        [{ round: 1, commit: "aaa", score: 4 }],
      ]);
      githubResult(harness.runtimeDirectory, {
        key: "wait-review-1",
        result: { number: 61, commit: "aaa", score: 1 },
      });
      githubResult(harness.runtimeDirectory, {
        key: "wait-review-2",
        result: { number: 61, commit: "bbb", score: 5 },
      });
      assert.deepEqual(await pullRequestData(watch.address), [
        pullRequest,
        [
          { round: 1, commit: "aaa", score: 4 },
          { round: 2, commit: "bbb", score: 5 },
        ],
      ]);
    } finally {
      assert.equal(await watch.stop(), 0);
    }
    await service.close();
  }));

async function nextMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  for (;;) {
    const chunk = await reader.read();
    const text = decoder.decode(chunk.value);
    if (chunk.done || text.includes("data:")) return text;
  }
}

await test("CLV-016 cloving watch has an event stream that sends one message at the connection of a page and one message for a change that the service commits", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const watch = await watching(harness.runtimeDirectory);
    try {
      const response = await fetch(`${watch.address}events`);
      assert.match(
        String(response.headers.get("content-type")),
        /^text\/event-stream/,
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.ok(response.body);
      const reader = response.body.getReader();
      assert.match(await nextMessage(reader), /data: change\n\n/);
      await delay(300);
      const next = nextMessage(reader);
      await waitingGate(harness, {
        service,
        commandId: "c-7",
        kind: "approval",
      });
      assert.match(await next, /data: change\n\n/);
      await reader.cancel();
    } finally {
      assert.equal(await watch.stop(), 0);
    }
    await service.close();
  }));

await test("CLV-016 cloving watch shows a service that does not answer with no run, and it reads a runtime directory with no journal", () =>
  withHarness(async (harness) => {
    const model = await watchedModel(harness.runtimeDirectory);
    assert.deepEqual(
      [field(model, "service"), field(model, "runs"), field(model, "host")],
      ["down", [], undefined],
    );
  }));

await test("CLV-016 cloving start with no known runtime directory starts nothing and names the setting", () => {
  const hidden = [
    "HOME",
    "XDG_RUNTIME_DIR",
    "XDG_STATE_HOME",
    "CLOVING_RUNTIME_DIR",
  ];
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !hidden.includes(name)),
  );
  const started = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "../src/cli.ts"), "start"],
    { env: environment, encoding: "utf8" },
  );
  assert.deepEqual([started.status, started.stdout], [1, ""]);
  assert.match(
    started.stderr,
    /^repository-unknown: Change to the service repository, use --repository <directory>, or set CLOVING_RUNTIME_DIR\./,
  );
});

await test("CLV-130 fixed font GETs serve packaged bytes without a service operation", async () => {
  const replies = watchReplies({ runs: [] });
  await withWatchService(replies.answer, async (watch) => {
    await servedFonts(watch.address, join(import.meta.dirname, ".."));
    assert.ok(replies.requests.length > 0);
    for (const operation of replies.requests)
      assert.deepEqual(operation, {
        operation: "events",
        parameters:
          operation.parameters["follow"] === true
            ? { after: 2500, follow: true }
            : { limit: 1 },
      });
  });
  await withHarness(async (harness) => {
    const watch = await watching(harness.runtimeDirectory, {
      directory: harness.projectDirectory,
    });
    try {
      await servedFonts(watch.address, join(import.meta.dirname, ".."));
    } finally {
      assert.equal(await watch.stop(), 0);
    }
  });
});

await test("CLV-130 raw asset targets reject methods, queries, encoded names and traversal aliases", async () => {
  await withHarness(async (harness) => {
    const watch = await watching(harness.runtimeDirectory);
    try {
      for (const name of fontNames) {
        const path = `/watch-fonts-v1/${name}`;
        for (const method of [
          "POST",
          "PUT",
          "PATCH",
          "DELETE",
          "HEAD",
          "OPTIONS",
        ])
          assert.equal(
            await rawFontStatus(watch.address, { path, method }),
            404,
          );
        for (const target of [
          path + "?",
          path + "?v=1",
          path.replace("-latin", "%2dlatin"),
          path.replace("watch-fonts", "%77atch-fonts"),
          `/other/..${path}`,
          `/other/%2e%2e${path}`,
          `/watch-fonts-v1/../watch-fonts-v1/${name}`,
          `/watch-fonts-v1/%2e%2e/watch-fonts-v1/${name}`,
          `/watch-fonts-v1%2f${name}`,
          `/watch-fonts-v1/%2e%2e%2f${name}`,
          `/${path}`,
          path + "#fragment",
        ])
          assert.equal(
            await rawFontStatus(watch.address, { path: target }),
            404,
            target,
          );
      }
      for (const target of [
        "/watch-fonts-v1",
        "/watch-fonts-v1/",
        "/watch-fonts-v1/unknown.woff2",
        "/watch-fonts-v1/../package.json",
        "/watch-fonts-v1/%2e%2e%2fpackage.json",
        "/watch-fonts-v1/fira-code-OFL.md",
        "/watch-fonts-v1/manifest.json",
      ])
        assert.equal(
          await rawFontStatus(watch.address, { path: target }),
          404,
          target,
        );
    } finally {
      assert.equal(await watch.stop(), 0);
    }
  });
});
