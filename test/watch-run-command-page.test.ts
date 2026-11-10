import assert from "node:assert/strict";
import { test } from "node:test";
import { fields, items } from "./service-fixture.ts";
import { played } from "./watch-browser.ts";
import { floorModel, floorRun } from "./watch-floor-fixture.ts";

function revised(
  run: Record<string, unknown>,
  status: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const shown = run["status"];
  return {
    ...run,
    status: { ...(typeof shown === "object" ? shown : {}), ...status },
  };
}

const working = floorRun("run-a", { operation: "claude-turn", minutes: 5 });
const running = floorModel([revised(working, { revision: 4 })]);
const paused = floorModel([revised(working, { revision: 5, state: "paused" })]);

const scenario = `
const { running, paused } = JSON.parse(process.env.WATCH_MODEL);
const posts = [];
const answers = [];
const plain = globalThis.fetch;
globalThis.fetch = (address, options) => {
  if (options?.method !== "POST") return plain(address, options);
  posts.push({ address, ...options });
  const answer = answers.shift();
  if (answer === undefined) return Promise.reject(new Error("lost"));
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer) });
};
const button = (label) => app.all("button").find((node) => node.text === label);
const press = async (label, next) => {
  replies.push(next);
  button(label).dispatch("click");
  for (let turn = 0; turn < 5; turn++) await settled();
};
const message = () => app.all("p").find((node) => node.getAttribute("class") === "run-command-message")?.text ?? null;
const labels = () => app.all("div").filter((node) => node.getAttribute("class") === "run-command").flatMap((node) => node.all("button").map((item) => item.text));
const seen = [];
const look = (name) => { seen.push({ name, message: message(), labels: labels(), sent: posts.length, loads: requests.filter((address) => address === "data.json").length }); };
location.hash = "#run=run-a";
replies.push(running);
await load();
look("start");
answers.push({ kind: "run-command", command: "pause", committed: { state: "paused", revision: 5 } });
await press("Pause", paused);
look("paused");
await press("Resume", paused);
look("lost");
answers.push({ kind: "run-command", command: "resume", committed: { state: "running", revision: 6 } });
await press("Resume", running);
look("resumed");
answers.push({ error: { code: "stale-revision", detail: "stale-revision", currentRevision: 9 } });
await press("Pause", running);
look("stale");
answers.push({ error: { code: "run-cancelled", detail: "The run is cancelled." } });
await press("Pause", running);
look("refused");
button("Drop").dispatch("click");
look("asked");
button("Keep it").dispatch("click");
look("kept");
button("Drop").dispatch("click");
answers.push({ kind: "run-command", command: "drop", committed: { state: "cancelled", revision: 5 } });
await press("Drop the run", running);
look("dropped");
console.log(JSON.stringify({ posts, seen }));
`;

const lost =
  "The watch tool does not answer. Click again to send the same command.";
const refused = "run-cancelled: The run is cancelled.";
const stale = "The run changed. Look again and try again.";

const expectedLooks = [
  ["start", null, 0, 1, "Pause", "Drop"],
  ["paused", "Paused", 1, 2, "Resume", "Drop"],
  ["lost", lost, 2, 3, "Resume", "Drop"],
  ["resumed", "Resumed", 3, 4, "Pause", "Drop"],
  ["stale", stale, 4, 5, "Pause", "Drop"],
  ["refused", refused, 5, 6, "Pause", "Drop"],
  ["asked", refused, 5, 6, "Drop the run", "Keep it"],
  ["kept", refused, 5, 6, "Pause", "Drop"],
  ["dropped", "Dropped", 6, 7, "Pause", "Drop"],
];

function looks(result: Readonly<Record<string, unknown>>): unknown[][] {
  return items(result["seen"])
    .map(fields)
    .map((look) => [
      look["name"],
      look["message"],
      look["sent"],
      look["loads"],
      ...items(look["labels"]),
    ]);
}

function checkedPosts(
  result: Readonly<Record<string, unknown>>,
): readonly string[] {
  const posts = items(result["posts"]).map(fields);
  assert.deepEqual(fields(posts[0]?.["headers"]), {
    "content-type": "application/json",
    "x-cloving-token": "a".repeat(64),
  });
  const bodies = posts.map((post) => fields(JSON.parse(String(post["body"]))));
  assert.deepEqual(
    posts.map((post, index) => [
      post["address"],
      post["method"],
      bodies[index]?.["runId"],
      bodies[index]?.["expectedRevision"],
    ]),
    [
      ["actions/pause", "POST", "run-a", 4],
      ["actions/resume", "POST", "run-a", 5],
      ["actions/resume", "POST", "run-a", 5],
      ["actions/pause", "POST", "run-a", 4],
      ["actions/pause", "POST", "run-a", 4],
      ["actions/drop", "POST", "run-a", 4],
    ],
  );
  assert.deepEqual(
    bodies.map((body) => Object.keys(body)),
    bodies.map(() => ["runId", "expectedRevision", "commandId"]),
  );
  return bodies.map((body) => String(body["commandId"]));
}

await test("CLV-335 the page posts Pause, Resume and Drop with the revision of the run and a random command ID that a retry keeps, asks a second click for Drop, and shows the reply in one line", () => {
  const models = {
    running,
    paused,
    updatedAt: running.updatedAt,
    cardForms: [],
  };
  const result = played(models, scenario);
  const ids = checkedPosts(result);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.equal(ids[1], ids[2], "a retry after a lost reply keeps the ID");
  assert.equal(new Set(ids).size, 5);
  assert.deepEqual(looks(result), expectedLooks);
});
