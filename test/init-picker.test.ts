import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { chooseHarness } from "../src/cli/init-selection.ts";
import { createProbeRunner } from "../src/cli/probe-command.ts";
import { withDoctor } from "./doctor-fixture.ts";

const probe = createProbeRunner({
  spawn: (input) => spawn(input.executable, input.arguments, input.options),
  kill: (identifier, signal) => process.kill(identifier, signal),
});

await test("CLV-209 picker lists usable entries, current default first, and Other last", () =>
  withDoctor(async (scene) => {
    await scene.program("grok", 'console.log("Error: unavailable")');
    const questions: string[] = [];
    const selected = await chooseHarness({
      environment: scene.environment,
      probe,
      current: { name: "codex", kind: "file", path: scene.root + "/bin/codex" },
      question: (text) => {
        questions.push(text);
        return Promise.resolve("");
      },
    });
    assert.equal(selected.name, "codex");
    assert.equal(questions.length, 1);
    const text = questions[0] ?? "";
    assert.match(text, /1\..*codex/);
    assert.match(text, /2\..*claude/);
    assert.match(text, /3\..*Other: type a name or a path/);
    assert.doesNotMatch(text, /grok/);
    assert.match(text, /Which agent harness do you want for the setup/);
  }));

await test("CLV-209 Other probes a custom harness name before selecting it", () =>
  withDoctor(async (scene) => {
    const file = await scene.program("custom", 'console.log("1.0.0")');
    const answers = ["3", "custom"];
    const questions: string[] = [];
    const selected = await chooseHarness({
      environment: scene.environment,
      probe,
      current: undefined,
      question: (text) => {
        questions.push(text);
        return Promise.resolve(answers.shift() ?? "");
      },
    });
    assert.equal(selected.path, file);
    assert.equal(questions.length, 2);
    assert.match(questions[1] ?? "", /name or.*path/);
  }));

await test("CLV-209 Other refuses an unusable path", () =>
  withDoctor(async (scene) => {
    const file = await scene.program(
      "broken",
      'console.log("Error: unavailable")',
    );
    const answers = ["3", file];
    await assert.rejects(
      chooseHarness({
        environment: scene.environment,
        probe,
        current: undefined,
        question: () => Promise.resolve(answers.shift() ?? ""),
      }),
      /harness-unusable/,
    );
  }));

await test("CLV-209 picker refuses invalid choices", () =>
  withDoctor(async (scene) => {
    await assert.rejects(
      chooseHarness({
        environment: scene.environment,
        probe,
        current: undefined,
        question: () => Promise.resolve("99"),
      }),
      /harness-not-selected/,
    );
  }));

await test("CLV-209 picker accepts a saved default with only its name configured", () =>
  withDoctor(async (scene) => {
    const entry = await chooseHarness({
      environment: scene.environment,
      probe,
      current: { name: "codex" },
      question: () => Promise.resolve("1"),
    });
    assert.equal(entry.name, "codex");
  }));

await test("CLV-209 picker rediscovers a custom shell default outside the known harness list", () =>
  withDoctor(async (scene) => {
    await writeFile(
      join(scene.root, ".zshrc"),
      'custom() { printf "1.0.0\\n"; }\n',
    );
    const entry = await chooseHarness({
      environment: {
        ...scene.environment,
        SHELL: "/bin/zsh",
        ZDOTDIR: scene.root,
      },
      probe,
      current: { name: "custom", kind: "shell", path: "custom" },
      question: () => Promise.resolve("1"),
    });
    assert.equal(entry.kind, "shell");
    assert.equal(entry.path, "custom");
  }));

await test("CLV-209 picker omits an unavailable saved default", () =>
  withDoctor(async (scene) => {
    const entry = await chooseHarness({
      environment: scene.environment,
      probe,
      current: { name: "missing" },
      question: () => Promise.resolve("1"),
    });
    assert.equal(entry.name, "claude");
  }));
