import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const engineScript = `
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(LOG, JSON.stringify(args) + "\\n");
if (args[0] !== "run") process.exit(0);
const valued = ["-v", "-w", "-e", "--name"];
const options = { v: [], e: [], w: undefined };
let index = 1;
while (index < args.length && args[index].startsWith("-")) {
  const flag = args[index];
  const value = args[index + 1];
  if (flag === "-v") options.v.push(value);
  if (flag === "-e") options.e.push(value);
  if (flag === "-w") options.w = value;
  index += valued.includes(flag) ? 2 : 1;
}
const [, executable, ...rest] = args.slice(index);
const environment = { PATH: process.env.PATH };
for (const item of options.e) {
  const at = item.indexOf("=");
  if (at === -1) environment[item] = process.env[item];
  else environment[item.slice(0, at)] = item.slice(at + 1);
}
const common = options.v[1].split(":")[0];
if (READONLY) chmodSync(common, 0o555);
const child = spawn(executable, rest, { cwd: options.w, env: environment, stdio: "inherit" });
child.on("exit", (code) => {
  if (READONLY) chmodSync(common, 0o755);
  process.exit(code ?? 1);
});
`;

const sandboxScript = `
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const settings = JSON.parse(readFileSync(args[1], "utf8"));
const temporary = process.env.CLAUDE_CODE_TMPDIR;
appendFileSync(LOG, JSON.stringify({ args, settings, temporary, made: existsSync(temporary) }) + "\\n");
if (args[2] !== "--") process.exit(64);
const [executable, ...rest] = args.slice(3);
const child = spawn(executable, rest, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
`;

export interface FakeProgram {
  readonly path: string;
  readonly calls: () => readonly unknown[];
}

function program(
  directory: string,
  source: { readonly name: string; readonly body: string },
): FakeProgram {
  const path = join(directory, source.name);
  const log = `${path}.log`;
  writeFileSync(
    path,
    `#!${process.execPath}\nconst LOG = ${JSON.stringify(log)};\n${source.body}`,
  );
  chmodSync(path, 0o755);
  return {
    path,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line): unknown => JSON.parse(line))
        : [],
  };
}

export function fakeEngine(
  directory: string,
  options: { readonly access: "write" | "read-only" },
): FakeProgram {
  return program(directory, {
    name: `engine-${options.access}`,
    body: `const READONLY = ${String(options.access === "read-only")};\n${engineScript}`,
  });
}

export function fakeSandbox(directory: string): FakeProgram {
  return program(directory, { name: "srt", body: sandboxScript });
}
