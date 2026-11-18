import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createProbeRunner } from "../src/cli/probe-command.ts";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import type { DoctorScene } from "./doctor-fixture.ts";

export const setupMessage = ["run `cloving init-prompt`"];
export const versionLines = [
  "pi version 1.5.3",
  "v1.5.3",
  "1.5",
  "1.5.3",
  "1.5.2",
] as const;
export const probe = createProbeRunner({
  spawn: (input) => spawn(input.executable, input.arguments, input.options),
  kill: (identifier, signal) => process.kill(identifier, signal),
});

export function acceptedByVersion19(output: string): boolean {
  const line = output.split(/\r?\n/, 1)[0] ?? "";
  if (/\b(?:error|unavailable|not found)\b/i.test(line)) return false;
  return /\d+\.\d+/.test(line);
}

export function piBody(version: string): string {
  return [
    'if (process.argv[2] === "--version") {',
    "  if (process.argv.length !== 3) process.exit(91);",
    `  console.log(${JSON.stringify(version)});`,
    "} else {",
    "  console.log(JSON.stringify(process.argv.slice(2)));",
    "  process.exit(7);",
    "}",
  ].join("\n");
}

export async function setupPi(
  scene: DoctorScene,
  input: { readonly kind: "file" | "shell"; readonly version: string },
) {
  const shell = input.kind === "shell";
  const program = await scene.program(
    shell ? "receiver" : "pi",
    piBody(input.version),
  );
  await writeFile(
    join(scene.root, ".zshrc"),
    `pi() { ${JSON.stringify(program)} "$@"; }\n`,
  );
  return {
    program,
    target: shell ? "shell:pi" : "pi",
    harness: { name: "pi", kind: input.kind, path: shell ? "pi" : program },
    file: privateSettingsPath(scene.environment, scene.repository),
    environment: {
      ...scene.environment,
      SHELL: shell ? "/bin/zsh" : "/missing-shell",
      ZDOTDIR: scene.root,
    },
  };
}

export async function outsidePi(scene: DoctorScene): Promise<string> {
  const path = join(scene.root, "other", "pi");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!${process.execPath}\n${piBody("1.5.3")}\n`);
  await chmod(path, 0o755);
  return path;
}

export async function saveSelection(
  file: string,
  harness: object,
): Promise<string> {
  const text = JSON.stringify({ version: 1, harness });
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return text;
}

export async function savedHarness(file: string): Promise<unknown> {
  const saved: unknown = JSON.parse(await readFile(file, "utf8"));
  assert.ok(typeof saved === "object" && saved !== null && "harness" in saved);
  return saved.harness;
}

export function asked() {
  const prompts: string[] = [];
  return {
    prompts,
    question: (text: string) => {
      prompts.push(text);
      return Promise.resolve("");
    },
  };
}
