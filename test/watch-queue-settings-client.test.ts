import assert from "node:assert/strict";
import { test } from "node:test";
import { played } from "./watch-browser.ts";
import { floorModel } from "./watch-floor-fixture.ts";

const queue = {
  workflowId: "develop-issue",
  state: "running",
  lanes: 2,
  busy: 1,
  settings: { workingLanes: { value: 2, source: "default" } },
};
const globalQueue = {
  state: "running",
  lanes: 16,
  configuredLanes: null,
  busy: 1,
  workingLanes: 16,
  configuredWorkingLanes: null,
  eligible: true,
};
const model = {
  ...floorModel([]),
  queues: [queue],
  globalQueue,
  cardForms: [],
};
const change = {
  scope: "global",
  field: "lanes",
  action: "set",
  expectedValue: 16,
  value: 3,
};

await test("CLV-377 a written IPC reset with a lost reply retains the exact request while a pre-send refusal stays definite", () => {
  const result = played(
    model,
    `
const { send } = await import(${JSON.stringify(import.meta.resolve("../src/cli/client.ts"))});
const { socketAddress } = await import(${JSON.stringify(import.meta.resolve("../src/broker/socket-address.ts"))});
const { createServer } = await import("node:net");
const { mkdtemp, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const runtime = await mkdtemp(join(tmpdir(), "clv-"));
location.hash = "";
const model = JSON.parse(process.env.WATCH_MODEL);
model.globalQueue = {...model.globalQueue, lanes:4, configuredLanes:4, workingLanes:4, sources:{lanes:"queue setting (private file)"}};
const effective = {...model.globalQueue, lanes:16, configuredLanes:null, workingLanes:16, sources:{lanes:"default"}};
const posts = []; let writes = 0;
const server = createServer(socket => socket.once("data", bytes => {
  const command = JSON.parse(bytes.toString()).parameters;
  posts.push(command);
  if (posts.length === 1) { writes += 1; socket.destroy(); return; }
  socket.end(JSON.stringify({ok:true, result:{kind:"queue-setting", commandId:command.commandId, globalQueue:effective}}) + "\\n");
}));
await new Promise(resolve => server.listen(socketAddress(join(runtime,"control.sock")).path, resolve));
try {
  replies.push(model); await load();
  const plain = globalThis.fetch;
  globalThis.fetch = (address, options) => options?.method === "POST"
    ? Promise.resolve({ok:true, json:async()=> {const reply = await send(runtime,{operation:"queue-setting",parameters:JSON.parse(options.body)}); return reply.kind === "error" ? {error:reply.error} : reply.result;}})
    : plain(address, options);
  replies.push(model); await queueSettingPost({scope:"global",field:"lanes",action:"inherit",expectedValue:4});
  const retry = queueControls().retry;
  replies.push({...model,globalQueue:effective}); await queueSettingRetry("@global");
  await new Promise(resolve => server.close(resolve));
  const unsent = await send(runtime,{operation:"queue-setting",parameters:posts[0]});
  console.log(JSON.stringify({posts,writes,retry,controls:queueControls(),unsent}));
} finally { if(server.listening) server.close(); await rm(runtime,{recursive:true,force:true}); }
`,
  );
  const posts = result["posts"];
  assert.ok(Array.isArray(posts));
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0], posts[1]);
  assert.equal(result["writes"], 1);
  assert.deepEqual(result["retry"], ["@global"]);
  assert.match(JSON.stringify(result["controls"]), /Saved/);
  assert.match(JSON.stringify(result["unsent"]), /service-unavailable/);
});

await test("CLV-377 inheritance cannot acknowledge a private controlling source that survived reload", () => {
  const result = played(
    model,
    `console.log(JSON.stringify({ confirmed: settingConfirmed({ ...JSON.parse(process.env.WATCH_MODEL).globalQueue, sources: {lanes: "queue setting (private file)"} }, {scope:"global", field:"lanes", action:"inherit"}) }));`,
  );
  assert.equal(result["confirmed"], false);
});

await test("CLV-377 saved resets retain their exact request until retry confirms the inherited running value", () => {
  for (const scope of ["global", "workflow"]) {
    const result = played(
      model,
      `
location.hash = "";
const model = JSON.parse(process.env.WATCH_MODEL);
const scope = ${JSON.stringify(scope)};
const key = scope === "global" ? "@global" : "develop-issue";
const privateSource = { value: 4, source: "queue setting (private file)" };
model.globalQueue = { ...model.globalQueue, lanes: 4, configuredLanes: 4, workingLanes: 4, sources: { lanes: privateSource.source } };
model.queues[0] = { ...model.queues[0], lanes: 4, settings: { lanes: privateSource, workingLanes: { value: 4, source: "default" } } };
replies.push(model); await load();
const inherited = scope === "global"
  ? { ...model.globalQueue, lanes: 16, configuredLanes: null, workingLanes: 16, sources: { lanes: "default" } }
  : { ...model.queues[0], lanes: 8, settings: { lanes: { value: 8, source: "declaration" }, workingLanes: { value: 8, source: "default" } } };
const next = scope === "global" ? { ...model, globalQueue: inherited } : { ...model, queues: [inherited] };
const change = { scope, field: "lanes", action: "inherit", expectedValue: 4, ...(scope === "workflow" ? {workflowId: key} : {}) };
const posts = []; const plain = globalThis.fetch;
globalThis.fetch = (address, options) => {
  if (options?.method !== "POST") return plain(address, options);
  const command = JSON.parse(options.body); posts.push(command);
  return Promise.resolve({ok: true, json: async () => posts.length === 1
    ? {error: {code: "queue-setting-failed", detail: "The setting was saved but not applied. Fix the workflow and retry this request.", saved: true}}
    : {kind: "queue-setting", commandId: command.commandId, ...(scope === "global" ? {globalQueue: inherited} : {queues: [inherited]})}});
};
replies.push(model); await queueSettingPost(change);
const failed = { text: app.text, controls: queueControls(), lanes: settingQueue(state.model, change).lanes };
await queueSettingPost({ ...change, action: "set", value: 5 });
replies.push(next); await queueSettingRetry(key);
console.log(JSON.stringify({ posts, failed, message: state.queueMessages[key], controls: queueControls(), lanes: settingQueue(state.model, change).lanes }));
`,
    );
    const posts = result["posts"];
    assert.ok(Array.isArray(posts));
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[0], posts[1]);
    assert.match(JSON.stringify(result["failed"]), /Retry same request/);
    assert.doesNotMatch(JSON.stringify(result["failed"]), /Saved/);
    assert.equal(Reflect.get(Object(result["failed"]), "lanes"), 4);
    assert.equal(result["message"], "");
    assert.equal(result["lanes"], scope === "global" ? 16 : 8);
    assert.deepEqual(Reflect.get(Object(result["controls"]), "retry"), []);
    assert.match(JSON.stringify(result["controls"]), /Saved/);
  }
});

await test("CLV-377 a definitive save refusal releases the client request for a corrected edit", () => {
  const result = played(
    model,
    `
location.hash = "";
const model = JSON.parse(process.env.WATCH_MODEL);
replies.push(model); await load();
const posts = []; const plain = globalThis.fetch;
globalThis.fetch = (address, options) => {
  if (options?.method !== "POST") return plain(address, options);
  posts.push(JSON.parse(options.body));
  return Promise.resolve({ok: true, json: async () => ({error: {code: "queue-setting-failed", detail: "Change the controlling override first."}})});
};
replies.push(model); await queueSettingPost(${JSON.stringify(change)});
replies.push(model); await queueSettingPost({ ...${JSON.stringify(change)}, value: 4 });
console.log(JSON.stringify({ posts, controls: queueControls(), message: state.queueMessages["@global"] }));
`,
  );
  const posts = result["posts"];
  assert.ok(Array.isArray(posts));
  assert.equal(posts.length, 2);
  assert.notEqual(
    Reflect.get(Object(posts[0]), "commandId"),
    Reflect.get(Object(posts[1]), "commandId"),
  );
  assert.deepEqual(Reflect.get(Object(result["controls"]), "retry"), []);
  assert.match(String(result["message"]), /controlling override/);
});

await test("CLV-377 per-scope client requests are bounded, isolated and confirmed against an exact fresh read", () => {
  const result = played(
    model,
    `
assertSettingClient();
function assertSettingClient() { if (typeof queueSettingPost !== "function") throw new Error("Typed setting client is missing"); }
location.hash = "";
const model = JSON.parse(process.env.WATCH_MODEL);
replies.push(model); await load();
const posts = []; let answer;
const plain = globalThis.fetch;
globalThis.fetch = (address, options) => options?.method === "POST" ? (posts.push({address, body: JSON.parse(options.body)}), new Promise(resolve => { answer = resolve; })) : plain(address, options);
const pending = queueSettingPost(${JSON.stringify(change)});
await queueSettingPost({ ...${JSON.stringify(change)}, value: 4 });
const effective = { ...model.globalQueue, lanes: 3, configuredLanes: 3, workingLanes: 3 };
replies.push({ ...model, globalQueue: effective });
answer({ ok: true, status: 200, json: async () => ({kind: "queue-setting", commandId: posts[0].body.commandId, globalQueue: effective}) });
await pending;
console.log(JSON.stringify({ posts, queue: state.model.queues[0], controls: queueControls(), message: state.queueMessages["@global"] }));
`,
  );
  assert.equal(Array.isArray(result["posts"]) && result["posts"].length, 1);
  assert.equal(Reflect.get(Object(result["queue"]), "lanes"), 2);
  assert.equal(result["message"], "");
  assert.match(JSON.stringify(result["controls"]), /Saved/);
});

await test("CLV-377 an uncertain reply holds one request ID and refuses a different edit until that request is resolved", () => {
  const result = played(
    model,
    `
if (typeof queueSettingPost !== "function") throw new Error("Typed setting client is missing");
location.hash = "";
const model = JSON.parse(process.env.WATCH_MODEL);
replies.push(model); await load();
const posts = []; const plain = globalThis.fetch;
globalThis.fetch = (address, options) => {
 if (options?.method !== "POST") return plain(address, options);
 posts.push(JSON.parse(options.body)); return Promise.reject(new Error("lost reply"));
};
replies.push(model); await queueSettingPost(${JSON.stringify(change)});
await queueSettingPost({ ...${JSON.stringify(change)}, value: 4 });
replies.push(model); await queueSettingRetry("@global");
console.log(JSON.stringify({ posts, message: state.queueMessages["@global"], retry: queueControls().retry }));
`,
  );
  const posts = result["posts"];
  assert.ok(Array.isArray(posts));
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0], posts[1]);
  assert.match(String(result["message"]), /not confirmed|unknown|retry/i);
  assert.deepEqual(result["retry"], ["@global"]);
});

await test("CLV-377 a stale or lost effective read cannot acknowledge saved even after a successful action", () => {
  for (const fresh of [
    null,
    {
      ...model,
      globalQueue: {
        ...globalQueue,
        lanes: 4,
        configuredLanes: 4,
        workingLanes: 4,
      },
    },
  ]) {
    const result = played(
      model,
      `
if (typeof queueSettingPost !== "function") throw new Error("Typed setting client is missing");
location.hash = "";
const model = JSON.parse(process.env.WATCH_MODEL);
replies.push(model); await load();
const plain = globalThis.fetch;
globalThis.fetch = (address, options) => options?.method === "POST" ? Promise.resolve({ok: true, json: async () => ({kind: "queue-setting", commandId: JSON.parse(options.body).commandId, globalQueue: {...model.globalQueue, lanes:3, configuredLanes:3, workingLanes:3}})}) : plain(address, options);
replies.push(${JSON.stringify(fresh)});
await queueSettingPost(${JSON.stringify(change)});
console.log(JSON.stringify({message: state.queueMessages["@global"], controls: queueControls()}));
`,
    );
    assert.match(String(result["message"]), /not confirmed.*Refresh/);
    assert.doesNotMatch(JSON.stringify(result["controls"]), /Saved/);
  }
});

await test("CLV-377 an applying action waits for a fresh read even when an event read is already in flight", () => {
  const result = played(
    model,
    `
location.hash = "";
const model = JSON.parse(process.env.WATCH_MODEL);
replies.push(model); await load();
const effective = { ...model.globalQueue, lanes: 3, configuredLanes: 3, workingLanes: 3 };
const next = { ...model, globalQueue: effective };
let finish; let reads = 0;
globalThis.fetch = (address, options) => {
 if (options?.method === "POST") return Promise.resolve({ok:true, json:async()=>({kind:"queue-setting", commandId: JSON.parse(options.body).commandId, globalQueue:effective})});
 reads += 1;
 if (reads === 1) return new Promise(resolve => { finish = () => resolve({ok:true, json:async()=>model}); });
 return Promise.resolve({ok:true, json:async()=>next});
};
const oldRead = load();
const applying = queueSettingPost(${JSON.stringify(change)});
await settled(); finish();
await oldRead; await applying; await settled();
console.log(JSON.stringify({ controls: queueControls(), message: state.queueMessages["@global"], reads }));
`,
  );
  assert.equal(result["reads"], 2);
  assert.equal(result["message"], "");
  assert.match(JSON.stringify(result["controls"]), /Saved/);
});
