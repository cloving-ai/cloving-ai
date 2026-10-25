import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const product = join(import.meta.dirname, "..");
const located = (file: string): string =>
  JSON.stringify(pathToFileURL(join(product, file)).href);

const hook = `
import { registerHooks } from "node:module";
const prefix = "cloving/workflows";
const sources = ${located("src/")};
registerHooks({
  resolve: (specifier, context, nextResolve) =>
    specifier.startsWith(prefix)
      ? nextResolve(sources + (specifier.slice(prefix.length + 1) || "workflows") + ".ts", context)
      : nextResolve(specifier, context),
});
`;

const scenario = `
import { developTicket } from ${located("workflows/develop-ticket.ts")};
import { developPrd } from ${located("workflows/develop-prd.ts")};
import { authorizeEffect } from ${located("src/effect-authorization.ts")};
const cases = JSON.parse(process.argv[2]);
const key = Symbol.for("cloving.step-bridge/v1");
const unavailable = { kind: "unavailable", reason: "no-scenario-result" };
const next = async (given, request, index) => {
  if (given.github !== undefined && request.capability === "github" && ["close-issue", "partial-issue"].includes(request.method)) {
    const { githubWorker } = await import(${located("src/daemon/github-worker.ts")});
    let reported;
    const operationId = given.operationPrefix + ":" + index;
    const worker = githubWorker({
      ...given.github,
      document: async () => request.payload,
      report: async (report) => { if (report.operationId === operationId) reported = report; },
      operationStatus: async () => "running",
      runStatus: async () => "running",
    });
    await worker.scan();
    const delivered = await worker.deliver({
      kind: "protected-effect", runId: given.operationPrefix, operationId,
      workflow: "sha256:pin", inputDigest: "sha256:input", purpose: "dispatch", leaseGeneration: 1,
      capability: "github", method: request.method, target: request.target, payload: "sha256:payload",
    }, new AbortController().signal);
    if (delivered.kind === "failed") throw new Error(delivered.reason);
    while (reported === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
    await worker.close();
    return { kind: reported.outcome, operationId: reported.operationId, receipt: delivered.receipt, result: reported.result ?? null, reason: reported.reason ?? null };
  }
  return given.effects === undefined ? given.turn : given.effects[request.capability + " " + request.method]?.shift() ?? unavailable;
};
for (const given of cases) {
  const requests = [];
  let spent = 0;
  globalThis[key] = {
    effect: async (request) => {
      requests.push(["effect", request]);
      if (given.effectLimit !== undefined) {
        const allowed = authorizeEffect({ capabilities: ["claude", "github"] }, {
          budget: { limit: given.effectLimit, spent }, request,
        });
        if (allowed.kind === "rejected") return { kind: "refused", reason: allowed.reason };
        spent = allowed.spent;
      }
      return next(given, request, requests.length);
    },
    gate: async (request) => { requests.push(["gate", request]); return given.gate; },
    handoff: async () => given.effects?.handoff?.shift() ?? ({ kind: "completed", result: "target-run" }),
  };
  const workflows = { "develop-prd": developPrd, "develop-ticket": developTicket };
  const develop = workflows[given.workflow] ?? developTicket;
  const outcome = await develop(given.input, given.decision);
  process.stdout.write(JSON.stringify({ outcome, requests, ...(given.effectLimit === undefined ? {} : { spent }) }) + "\\n");
}
`;

const directory = mkdtempSync(join(tmpdir(), "cloving-workflow-"));
process.on("exit", () => {
  rmSync(directory, { recursive: true, force: true });
});
writeFileSync(join(directory, "hook.mjs"), hook);
writeFileSync(join(directory, "scenario.mjs"), scenario);

export function field(value: unknown, name: string | number): unknown {
  return Reflect.get(Object(value), name);
}

export function request(line: unknown, index: number): unknown {
  return field(field(field(line, "requests"), index), 1);
}

export async function ran(
  cases: readonly unknown[],
): Promise<readonly unknown[]> {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--import",
    join(directory, "hook.mjs"),
    join(directory, "scenario.mjs"),
    JSON.stringify(cases),
  ]);
  return stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line): unknown => JSON.parse(line));
}
