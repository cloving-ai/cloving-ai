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
const cases = JSON.parse(process.argv[2]);
const key = Symbol.for("cloving.step-bridge/v1");
const unavailable = { kind: "unavailable", reason: "no-scenario-result" };
const next = (given, request) => given.effects === undefined ? given.turn : given.effects[request.capability + " " + request.method]?.shift() ?? unavailable;
for (const given of cases) {
  const requests = [];
  globalThis[key] = {
    effect: async (request) => { requests.push(["effect", request]); return next(given, request); },
    gate: async (request) => { requests.push(["gate", request]); return given.gate; },
  };
  const develop = given.workflow === "develop-prd" ? developPrd : developTicket;
  const outcome = await develop(given.input, given.decision);
  process.stdout.write(JSON.stringify({ outcome, requests }) + "\\n");
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
