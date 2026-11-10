import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import type { WatchModel } from "../src/cli/watch-render.ts";
import { Page } from "../src/cli/watch-view.ts";
import { stepAge } from "../src/cli/watch-floor-view.ts";
import { played } from "./watch-browser.ts";
import { rendered } from "./watch-dom.ts";
import type { ShownSchedule } from "../src/cli/schedule-render.ts";
import {
  floorModel,
  floorRun,
  minutesBefore,
  twoLineModel,
} from "./watch-floor-fixture.ts";
import { activeSchedule, scheduleModel } from "./watch-schedule-fixture.ts";
import { noCopy } from "./watch-sample.ts";

function page(model: WatchModel, selected = ""): string {
  return rendered(
    component(Page, {
      model,
      selected,
      now: model.updatedAt,
      stale: false,
      copying: noCopy,
    }),
  );
}

function lines(html: string): readonly string[] {
  return html.split('<li class="line">').slice(1);
}

function stations(line: string): readonly string[] {
  return line.split('<li class="station').slice(1);
}

function names(line: string): readonly string[] {
  return stations(line).map(
    (station) => /<span class="station-name">([^<]*)</.exec(station)?.[1] ?? "",
  );
}

await test("CLV-286 the floor shows each workflow as a line of its stations in declared order", () => {
  const html = page(twoLineModel());
  assert.match(
    html,
    /<section class="floor"[^>]*><div class="floor-head"><h2[^>]*>Floor<\/h2>/,
  );
  const shown = lines(html);
  assert.equal(shown.length, 2);
  assert.match(
    shown[0] ?? "",
    /href="#workflow=develop-issue">develop-issue<\/a>/,
  );
  assert.match(shown[0] ?? "", /<span class="line-active">2 active<\/span>/);
  assert.deepEqual(names(shown[0] ?? ""), [
    "Work tree",
    "Agent turn",
    "Pull request",
    "Code review",
    "Merge",
  ]);
  assert.match(shown[1] ?? "", /href="#workflow=idea">idea<\/a>/);
  assert.deepEqual(names(shown[1] ?? ""), ["Draft", "Review"]);
  assert.doesNotMatch(html, /class="workflows"|class="columns"|class="column/);
});

await test("CLV-286 a run at its third step shows its token under the third station with its ticket and its time at the step", () => {
  const [develop = "", idea = ""] = lines(page(twoLineModel()));
  const third = stations(develop)[2] ?? "";
  assert.match(
    third,
    /<a class="token running" href="#run=pr-583" title="Title of pr-583"><span class="token-worker">C<\/span><span class="token-ticket">#583<\/span><span class="token-time">38m<\/span><\/a>/,
  );
  assert.match(
    stations(develop)[1] ?? "",
    /href="#run=turn-585"[\s\S]*>#585<[\s\S]*>3m</,
  );
  for (const index of [0, 3, 4])
    assert.doesNotMatch(stations(develop)[index] ?? "", /class="token/);
  assert.match(
    stations(idea)[0] ?? "",
    /href="#run=draft-run"[^>]*><span class="token-worker">C<\/span><span class="token-time">12m</,
  );
});

await test("CLV-286 a legend names the four lamp colors, and lamps and tokens carry the state of their runs", () => {
  const model = floorModel([
    floorRun("running", { operation: "github-open-pr", minutes: 9 }),
    floorRun("stopped", {
      operation: "github-open-pr",
      minutes: 51,
      state: "paused",
      harness: "claude",
    }),
  ]);
  const html = page(model);
  assert.match(
    html,
    /<ul class="legend" aria-label="Lamp colors"><li><span class="lamp running" aria-hidden="true"><\/span>Running<\/li><li><span class="lamp waiting" aria-hidden="true"><\/span>Waiting<\/li><li><span class="lamp needs-you" aria-hidden="true"><\/span>Needs you<\/li><li><span class="lamp stopped" aria-hidden="true"><\/span>Stopped<\/li><\/ul>/,
  );
  const [develop = ""] = lines(html);
  assert.match(
    stations(develop)[2] ?? "",
    /^ stopped"><span class="lamp stopped" title="Stopped"><\/span><span class="station-name">Pull request<\/span><ul class="tokens"><li><a class="token stopped" href="#run=stopped"[^>]*><span class="token-worker">C<\/span><span class="token-time">51m<\/span><\/a><\/li><li><a class="token running" href="#run=running"/,
  );
  assert.match(
    stations(develop)[0] ?? "",
    /^ empty"><span class="lamp empty" title="No run"><\/span><span class="station-name">Work tree<\/span><\/li>/,
  );
});

await test("CLV-286 the line end of a scheduled workflow with no loop row shows its next run time", () => {
  const clock = (at: number) =>
    new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const end = (schedule: ShownSchedule) => {
    const html = page({ ...scheduleModel(schedule), loops: [] });
    const [scheduled = "", manual = ""] = lines(html);
    assert.match(manual, /<div class="line-end"><\/div>/);
    return /<div class="line-end">([\s\S]*?)<\/div>/.exec(scheduled)?.[1];
  };
  const soon = activeSchedule.nextAt ?? 0;
  assert.equal(
    end(activeSchedule),
    `<span class="line-next">next run ${clock(soon)}</span>`,
  );
  const day = 24 * 60 * 60 * 1000;
  assert.equal(
    end({ ...activeSchedule, nextAt: soon + day }),
    `<span class="line-next">next run ${clock(soon + day)} tomorrow</span>`,
  );
  assert.equal(
    end({ ...activeSchedule, nextAt: soon + 3 * day }),
    `<span class="line-next">next run ${new Date(soon + 3 * day).toLocaleString()}</span>`,
  );
  assert.equal(
    end({ ...activeSchedule, state: "paused" }),
    '<span class="line-next">schedule paused</span>',
  );
  assert.equal(end({ ...activeSchedule, nextAt: null }), "");
});

function queuedModel(ready: unknown): WatchModel {
  return floorModel([], {
    queue: { workflowId: "develop-issue", lanes: 1, busy: 0, ready },
  });
}

await test("CLV-286 the line end of a queued workflow shows the count of ready tickets and the oldest wait", () => {
  const end = (ready: unknown) => {
    const [queued = "", other = ""] = lines(page(queuedModel(ready)));
    assert.match(other, /<div class="line-end"><\/div>/);
    return /<div class="line-end">([\s\S]*?)<\/div>/.exec(queued)?.[1];
  };
  assert.equal(
    end({ count: 3, oldestAt: minutesBefore(125) }),
    '<span class="line-ready">3 ready</span><span class="line-wait">oldest 2h 5m</span>',
  );
  assert.equal(
    end({ count: 1, oldestAt: minutesBefore(4) }),
    '<span class="line-ready">1 ready</span><span class="line-wait">oldest 4m</span>',
  );
  assert.equal(
    end({ count: 0, oldestAt: null }),
    '<span class="line-ready">0 ready</span>',
  );
  assert.equal(
    end({ failure: "The command failed." }),
    '<span class="line-ready" title="The command failed.">Ready list failed</span>',
  );
  assert.equal(end(undefined), "");
  const served = played(
    queuedModel({ count: 3, oldestAt: minutesBefore(125) }),
    `
const model = JSON.parse(process.env.WATCH_MODEL);
location.hash = "";
replies.push(model);
await load();
console.log(JSON.stringify({ html: app.inner }));
`,
  );
  assert.match(
    JSON.stringify(served["html"]),
    /<span class=\\"line-ready\\">3 ready<\/span><span class=\\"line-wait\\">oldest 2h 5m<\/span>/,
  );
});

await test("CLV-286 the header shows the count of active runs and of runs that need a person", () => {
  const model = floorModel(
    [
      floorRun("running", { operation: "github-open-pr" }),
      floorRun("stopped", { operation: "claude-turn", state: "paused" }),
      floorRun("person", { workflowId: "idea", operation: "write-draft" }),
      floorRun("done", { state: "completed", operation: "github-merge" }),
    ],
    {
      decisions: [
        {
          runId: "person",
          decisionId: "person/review-1",
          type: "approval",
          prompt: "Approve the draft.",
        },
      ],
    },
  );
  assert.match(
    page(model),
    /<div class="header-status"><span class="header-count"><strong>3<\/strong> active<\/span><span class="header-count needs-you"><strong>2<\/strong> need you<\/span><span>updated /,
  );
});

await test("CLV-286 selecting a token opens the run detail of that run, with a way back to the floor", () => {
  const model = twoLineModel();
  const href =
    /<a class="token running" href="#([^"]+)"[^>]*><span class="token-worker">C<\/span><span class="token-ticket">#583</.exec(
      page(model),
    )?.[1];
  assert.equal(href, "run=pr-583");
  const detail = page(model, href);
  assert.match(detail, /<a class="back" href="#">← Back to the floor<\/a>/);
  assert.match(detail, /<section class="banner working">[\s\S]*pr-583/);
  assert.doesNotMatch(detail, /class="floor"/);
  assert.match(
    page(model, "workflow=idea&run=draft-run"),
    /<a class="back" href="#workflow=idea">← Back to idea<\/a>/,
  );
});

await test("CLV-286 a line name opens the board of its workflow, without workflow tabs and with a way back to the floor", () => {
  const html = page(twoLineModel(), "workflow=develop-issue");
  assert.match(html, /<a class="back" href="#">← Back to the floor<\/a>/);
  assert.match(
    html,
    /<main class="board"><h2 class="visually-hidden">develop-issue<\/h2>/,
  );
  assert.doesNotMatch(html, /class="workflows"|class="floor"/);
  assert.match(
    page(twoLineModel(), "workflow=unknown"),
    /<section class="floor"/,
  );
});

await test("CLV-286 the served page shows the floor first, and a token click opens the run detail", () => {
  const result = played(
    twoLineModel(),
    `
const model = JSON.parse(process.env.WATCH_MODEL);
location.hash = "";
replies.push(model);
await load();
const floor = { html: app.inner, title: document.title };
const token = app.all("a").find((item) => item.attributes.get("href") === "#run=pr-583");
if (!token) throw new Error("missing token");
token.dispatch("click");
location.hash = token.attributes.get("href");
replies.push(model);
listeners.hashchange();
await settled();
console.log(JSON.stringify({ floor, run: { html: app.inner, title: document.title } }));
`,
  );
  const floor = JSON.stringify(result["floor"]);
  const run = JSON.stringify(result["run"]);
  assert.match(floor, /class=\\"floor\\"/);
  assert.match(floor, /Floor · Cloving/);
  assert.match(run, /← Back to the floor/);
  assert.match(run, /class=\\"banner working\\"/);
  assert.doesNotMatch(run, /class=\\"floor\\"/);
});

await test("CLV-286 the time at a step is short: minutes, then hours and minutes", () => {
  const now = "2026-10-14T12:00:00.000Z";
  assert.equal(stepAge("2026-10-14T11:22:00.000Z", now), "38m");
  assert.equal(stepAge("2026-10-14T09:55:00.000Z", now), "2h 5m");
  assert.equal(stepAge("2026-10-14T12:00:30.000Z", now), "0m");
  assert.equal(stepAge(null, now), "");
});
