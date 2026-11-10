import assert from "node:assert/strict";
import { test } from "node:test";
import type { Reply, ServiceRequest } from "../src/protocol.ts";
import { component } from "../src/cli/watch-element.ts";
import type { RenameControls } from "../src/cli/watch-rename-view.ts";
import { Page } from "../src/cli/watch-view.ts";
import { actionHeaders, pageToken, postCard } from "./watch-action-fixture.ts";
import { found, rendered } from "./watch-dom.ts";
import { noCopy } from "./watch-sample.ts";
import { withWatchService } from "./watch-service-fixture.ts";
import {
  promptTitle,
  pullTitle,
  renameControls,
  renameModel,
  type RenameCalls,
} from "./watch-rename-fixture.ts";

function page(selected: string, renaming?: RenameControls) {
  return component(Page, {
    model: renameModel,
    selected,
    now: renameModel.updatedAt,
    stale: false,
    copying: noCopy,
    ...(renaming === undefined ? {} : { renaming }),
  });
}

function calls(): RenameCalls {
  return { opened: [], saved: [], cleared: [], closed: [] };
}

function click(node: Readonly<Record<string, unknown>> | undefined): void {
  const handler = node?.["onClick"];
  assert.ok(typeof handler === "function");
  Reflect.apply(handler, undefined, []);
}

await test("CLV-334 the token, the card, Needs you and the run detail show the label and the pull request mark, and Draft shows nowhere", () => {
  const floor = rendered(page(""));
  assert.match(
    floor,
    /href="#run=pr-run"[^>]*><span class="token-worker">·<\/span><span class="token-ticket">SID-4820<\/span><span class="token-pull">PR #686<\/span>/,
  );
  assert.match(
    floor,
    /href="#run=prompt-run" title="Fix the flaky retention test in record-retention-loop"><span class="token-worker">C<\/span><span class="token-time">/,
  );
  assert.match(floor, /<span class="need-label">OWN-1<\/span> Own name/);
  const board = rendered(page("workflow=develop-issue"));
  assert.match(
    board,
    new RegExp(
      `<strong>${pullTitle}</strong><span class="card-ids"><span class="card-label">SID-4820</span><span class="card-pull">PR #686</span></span>`,
    ),
  );
  assert.match(
    board,
    new RegExp(`<strong>${promptTitle}</strong><span class="card-step`),
  );
  const detail = rendered(page("run=pr-run"));
  assert.match(
    detail,
    new RegExp(
      `<p class="run-name"><span class="name-label">SID-4820</span><span class="name-title">${pullTitle}</span><span class="name-pull">PR #686</span></p>`,
    ),
  );
  for (const html of [floor, board, detail, rendered(page("run=prompt-run"))])
    assert.doesNotMatch(html, /-(?:ticket|label)">Draft</);
});

await test("CLV-334 with the page token, the run detail and each card have Rename, and a manual name also has Use the automatic name", () => {
  for (const selected of ["run=manual-run", "workflow=develop-issue", ""])
    assert.equal(rendered(page(selected)).includes("Rename"), false);
  const recorded = calls();
  const buttons = (selected: string) =>
    found(page(selected, renameControls(recorded)), "button").filter((node) =>
      String(node["class"]).startsWith("rename-"),
    );
  const manual = buttons("run=manual-run");
  assert.deepEqual(
    manual.map((node) => node["children"]),
    ["Rename", "Use the automatic name"],
  );
  click(manual[0]);
  click(manual[1]);
  assert.deepEqual(recorded.opened, [
    { runId: "manual-run", title: "Own name", label: "OWN-1" },
  ]);
  assert.deepEqual(recorded.cleared, ["manual-run"]);
  assert.deepEqual(
    buttons("run=prompt-run").map((node) => node["children"]),
    ["Rename"],
  );
  assert.deepEqual(
    buttons("workflow=develop-issue").filter(
      (node) => node["children"] === "Rename",
    ).length,
    2,
  );
});

await test("CLV-334 the rename form holds the title and the label, Enter saves and Escape cancels", () => {
  const recorded = calls();
  const open = renameControls(recorded, {
    open: "manual-run",
    title: "Own name",
    label: "OWN-1",
  });
  const tree = page("run=manual-run", open);
  const inputs = found(tree, "input");
  assert.deepEqual(
    inputs.map((node) => [node["name"], node["value"]]),
    [
      ["title", "Own name"],
      ["label", "OWN-1"],
    ],
  );
  const form = found(tree, "form").find(
    (node) => node["class"] === "rename-form",
  );
  const submit = form?.["onSubmit"];
  const keyDown = form?.["onKeyDown"];
  assert.ok(typeof submit === "function" && typeof keyDown === "function");
  Reflect.apply(submit, undefined, [{ preventDefault: () => undefined }]);
  Reflect.apply(keyDown, undefined, [
    {
      key: "Escape",
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    },
  ]);
  assert.deepEqual(recorded.saved, ["manual-run"]);
  assert.deepEqual(recorded.closed, [1]);
  const busy = found(
    page("run=manual-run", { ...open, busy: ["manual-run"] }),
    "button",
  ).find((node) => node["type"] === "submit");
  assert.equal(busy?.["disabled"], true);
});

function answered(requests: ServiceRequest[]) {
  return (request: ServiceRequest): Reply => {
    if (request.operation !== "rename-run")
      return { kind: "result", result: { runs: [], workflows: [] } };
    requests.push(request);
    return {
      kind: "result",
      result: { kind: "run-renamed", runId: request.parameters["runId"] },
    };
  };
}

await test("CLV-334 the rename action sends rename-run with the command ID of the page only with the page token", () => {
  const requests: ServiceRequest[] = [];
  return withWatchService(answered(requests), async (watch) => {
    const good = actionHeaders(watch, await pageToken(watch));
    const sent = (body: unknown, headers = good) =>
      postCard(watch, {
        path: "actions/rename",
        headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    const valid = { runId: "pr-run", title: "New", commandId: "c-1" };
    const forged = { ...good, "x-cloving-token": "b".repeat(64) };
    assert.equal((await sent(valid, forged)).status, 403);
    for (const body of [
      { ...valid, runId: "bad id" },
      { ...valid, commandId: "bad id" },
      { ...valid, title: 7 },
      { ...valid, label: 7 },
      { runId: "pr-run", commandId: "c-1", clear: true, title: "New" },
      { runId: "pr-run", commandId: "c-1" },
      "[]",
      "{",
      { ...valid, title: "x".repeat(17000) },
    ])
      assert.equal(
        (await sent(body)).status,
        403,
        JSON.stringify(body).slice(0, 80),
      );
    assert.equal(requests.length, 0);
    const reply = await sent({ ...valid, label: "L-1" });
    assert.equal(reply.status, 200);
    assert.deepEqual(JSON.parse(reply.body), {
      kind: "run-renamed",
      runId: "pr-run",
    });
    assert.equal(
      (await sent({ runId: "pr-run", commandId: "c-2", clear: true })).status,
      200,
    );
    assert.deepEqual(
      requests.map((request) => request.parameters),
      [
        { runId: "pr-run", commandId: "c-1", title: "New", label: "L-1" },
        { runId: "pr-run", commandId: "c-2", clear: true },
      ],
    );
  });
});

await test("CLV-334 with CLOVING_WATCH_ACTIONS=off the rename endpoint answers 404", () =>
  withWatchService(
    {
      answer: answered([]),
      configure: () =>
        Promise.resolve({ environment: { CLOVING_WATCH_ACTIONS: "off" } }),
    },
    async (watch) => {
      const reply = await postCard(watch, {
        path: "actions/rename",
        headers: actionHeaders(watch, "wrong"),
        body: '{"runId":"pr-run","title":"New","commandId":"c-1"}',
      });
      assert.equal(reply.status, 404);
    },
  ));
