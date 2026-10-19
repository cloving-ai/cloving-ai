import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { productRoot } from "./world-host-fixture.ts";

export const queueWorkflow = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
export async function finish(input) {
  "use step";
  writeFileSync(input.repository + "/input-" + input.ticketId, JSON.stringify(input));
  const file = input.repository + "/outcome-" + input.ticketId;
  while (!existsSync(file)) await delay(20);
  return { kind: readFileSync(file, "utf8"), reason: "fixture result" };
}
export async function develop(input) {
  "use workflow";
  return await finish(input);
}
`;

const product = (file: string): string =>
  JSON.stringify(pathToFileURL(join(productRoot, file)).href);

export const queuePrelude = `
import assert from "node:assert/strict";
import { startDaemon } from ${product("src/daemon/daemon.ts")};
import { call } from ${product("test/service-fixture.ts")};
import { runIdentity } from ${product("src/service/submission-handler.ts")};
const directory = process.cwd();
const runtimeDirectory = directory + "/runtime";
const compiled = JSON.parse(readFileSync("artifacts/manifest.json", "utf8"));
const definition = Object.values(compiled.workflows).flatMap(Object.values)[0];
writeFileSync("develop.workflow.json", JSON.stringify({
  schemaVersion: 1, name: "develop", workflowId: definition.workflowId,
  steps: [], capabilities: ["claude", "github"], resources: [], artifacts: "artifacts"
}));
writeFileSync("next.mjs", \`import { appendFileSync, existsSync, readFileSync } from "node:fs";
appendFileSync("checks", "check\\\\n");
if (existsSync("ready")) process.stdout.write(readFileSync("ready", "utf8"));\`);
writeFileSync("ticket.mjs", 'process.stdout.write("# " + process.argv.at(-1) + ": Queue task");');
const settings = {
  directory, runtimeDirectory, repository: directory,
  manifests: { developTicket: directory + "/develop.workflow.json", developPrd: directory + "/develop.workflow.json" },
  workflows: { developTicket: workflows.develop, developPrd: workflows.develop },
  handler: POST, command: ["false"], concurrency: 1,
  nextCommand: [process.execPath, directory + "/next.mjs"],
  ticketCommand: [process.execPath, directory + "/ticket.mjs"],
  queueMilliseconds: 30,
};
const asked = (operation, parameters = {}) => call({ runtimeDirectory }, { operation, parameters });
const runs = async () => (await asked("status")).runs;
const shown = async (runId) => (await asked("status", { runId })).run;
const commands = () => {
  if (!existsSync("queue-commands.json")) return [];
  const value = JSON.parse(readFileSync("queue-commands.json", "utf8"));
  return Array.isArray(value) ? value : value.commands;
};
const until = async (read) => {
  for (let pass = 0; pass < 300; pass += 1) {
    const value = await read();
    if (value) return value;
    await delay(20);
  }
  throw new Error("queue-condition-not-reached");
};
const launched = async (overrides = {}) => {
  const opening = await startDaemon({ ...settings, ...overrides });
  assert.equal(opening.kind, "started", JSON.stringify(opening));
  return opening.daemon;
};
const submitted = async (commandId, overrides = {}) => asked("run", {
  workflowId: "develop-issue", source: "ticket", submission: { ticket: "CLV-900" }, commandId, ...overrides
});
`;
