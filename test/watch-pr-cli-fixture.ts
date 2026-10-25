import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { until } from "./claude-worker-fixture.ts";
import { fields, items } from "./service-fixture.ts";
import { prOutput } from "./watch-pr-fixture.ts";
import type { WatchCommandOutput } from "../src/cli/watch-pr-command.ts";
import type { Watching, WatchOptions } from "./watch-fixture.ts";
import { watchServer } from "../src/cli/watch-server.ts";

export async function directPrWatch(
  runtimeDirectory: string,
): Promise<Watching> {
  const ready = Promise.withResolvers<string>();
  const stopped = Promise.withResolvers<undefined>();
  const finished = watchServer({
    runtimeDirectory,
    port: 0,
    client: "codex",
    announce: (text) => {
      const address = /Watch page: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(
        text,
      )?.[1];
      assert.ok(address);
      ready.resolve(address);
    },
    complain: (text) => {
      ready.reject(new Error(text));
    },
    stopped: stopped.promise,
  });
  return {
    address: await ready.promise,
    stop: () => {
      stopped.resolve(undefined);
      return finished;
    },
  };
}

export async function configuredPrWatch(
  runtime: string,
): Promise<WatchOptions> {
  const root = dirname(runtime);
  const repository = join(root, "service-repository");
  await mkdir(repository);
  execFileSync("git", ["init", "--quiet", repository]);
  execFileSync("git", [
    "-C",
    repository,
    "config",
    "remote.origin.url",
    "git@github.example:fixture/demo.git",
  ]);
  const program = join(root, "fake gh.mjs");
  await writeFile(
    program,
    `import { writeFileSync, existsSync, readFileSync, watch } from "node:fs";
const root = ${JSON.stringify(root)};
writeFileSync(root + "/gh-pid", String(process.pid));
process.on("SIGTERM", () => {});
let responded = false;
const watcher = watch(root, respond);
const interval = setInterval(respond, 20);
function respond() {
  if (responded || !existsSync(root + "/gh-response")) return;
  responded = true;
  clearInterval(interval);
  watcher.close();
  const output = JSON.parse(readFileSync(root + "/gh-response", "utf8"));
  process.stdout.write(output.stdout);
  process.stderr.write(output.stderr);
  process.exitCode = output.status;
}
respond();
writeFileSync(root + "/gh-request", JSON.stringify(process.argv.slice(2)));
`,
  );
  return {
    directory: root,
    environment: {
      CLOVING_WATCH_REPOSITORY: repository,
      CLOVING_GH_COMMAND: JSON.stringify([
        process.execPath,
        program,
        "prefix with spaces",
      ]),
    },
  };
}

export async function ghRequest(runtime: string): Promise<unknown> {
  const file = join(dirname(runtime), "gh-request");
  await until(async () => {
    const [request, processId] = await Promise.all([
      readFile(file, "utf8").catch(() => ""),
      readFile(join(dirname(runtime), "gh-pid"), "utf8").catch(() => ""),
    ]);
    const pid = Number(processId);
    return request !== "" && Number.isSafeInteger(pid) && pid > 0;
  });
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  return value;
}

export async function recordedPrJournal(runtime: string): Promise<void> {
  const directory = join(dirname(runtime), "github/pr-7");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "started.json"),
    JSON.stringify({
      method: "open-pr",
      operationId: JSON.stringify([
        "cloving-operation",
        1,
        "stopped",
        "pull-request",
        "open-pr",
      ]),
    }),
  );
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify({
      outcome: "completed",
      result: JSON.stringify({
        number: 7,
        url: "https://github.example/fixture/demo/pull/7",
      }),
    }),
  );
}

export function stoppedPrCard(model: unknown) {
  const workflow = items(fields(model)["workflows"])
    .map(fields)
    .find((entry) => entry["workflowId"] === "develop-issue");
  const stopped = items(workflow?.["columns"])
    .map(fields)
    .find((entry) => entry["name"] === "Stopped");
  const card = items(stopped?.["cards"])
    .map(fields)
    .find((entry) => entry["runId"] === "stopped");
  assert.ok(card);
  return card;
}

export async function releasePr(
  runtime: string,
  merged: unknown,
): Promise<void> {
  await releasePrOutput(runtime, prOutput(merged));
}

export async function releasePrOutput(
  runtime: string,
  output: WatchCommandOutput,
): Promise<void> {
  const destination = join(dirname(runtime), "gh-response");
  const pending = `${destination}.pending`;
  await writeFile(pending, JSON.stringify(output));
  await rename(pending, destination);
}

export function stoppedPrRun() {
  return {
    runId: "stopped",
    workflowId: "develop-issue",
    ticketId: "7",
    state: "completed",
    outcome: { kind: "blocked" },
    latestSequence: 2,
    latestAt: new Date().toISOString(),
  };
}
