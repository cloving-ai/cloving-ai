import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startTurn, succeeded } from "../src/daemon/claude-turn.ts";
import { resultOf, withScene } from "./claude-worker-fixture.ts";
import { fakeEngine } from "./claude-runner-fixture.ts";
import { fakePi, piEvents, piMessage } from "./pi-fixture.ts";
import { read } from "./turn-transcript-fixture.ts";

await test("CLV-364 Pi literal arguments and large stdin preserve the exact prompt", async () => {
  const literal = '--option "quote"\nnext line\n';
  const atPrompt = '@literal\n"text"';
  const large = "a".repeat(200_000);
  for (const scenario of [
    { prompt: literal, arguments: ["--", literal], stdin: "" },
    { prompt: atPrompt, arguments: [], stdin: atPrompt },
    { prompt: large, arguments: [], stdin: large },
  ])
    await withScene(async (scene) => {
      const command = fakePi(scene);
      const end = await startTurn({
        worker: "pi",
        command: [command],
        directory: scene.repository,
        folder: scene.directory,
        prompt: scenario.prompt,
      }).ended;
      assert.equal(succeeded(end), true);
      const observed = resultOf(
        readFileSync(join(scene.directory, "observed.json"), "utf8"),
      );
      assert.deepEqual(observed["arguments"], scenario.arguments);
      assert.equal(observed["stdin"], scenario.stdin);
    });
});

await test("CLV-364 Pi preserves boundary whitespace through its pinned stdin input hook", async () => {
  for (const prompt of [
    '\n  --literal "quotes"\nRésumé 🐈\u2028\u2029' +
      "x".repeat(200_000) +
      " \n",
    '@literal\n"quoted"\n',
    " \n".repeat(70_000),
  ])
    await withScene(async (scene) => {
      const command = fakePi(scene);
      const end = await startTurn({
        worker: "pi",
        command: [command, "--mode", "json"],
        directory: scene.repository,
        folder: scene.directory,
        prompt,
      }).ended;
      assert.equal(succeeded(end), true);
      const observed = resultOf(
        readFileSync(join(scene.directory, "observed.json"), "utf8"),
      );
      assert.equal(observed["prompt"], prompt);
      assert.equal(JSON.parse(String(observed["stdin"])), prompt);
      assert.deepEqual(
        readdirSync(scene.directory).filter((name) =>
          name.startsWith("gh-config-"),
        ),
        [],
      );
    });
});

await test("CLV-364 Pi decodes split UTF-8, LF and CRLF without splitting Unicode separators", () =>
  withScene(async (scene) => {
    const text = "Résumé 🐈\u2028next\u2029line\nTicket status: complete";
    const output =
      piEvents(piMessage({ content: [{ type: "text", text }] }))
        .map((event) => JSON.stringify(event))
        .join("\r\n") + "\r\n";
    const command = fakePi(scene, { output, chunkBytes: 1 });
    const end = await startTurn({
      worker: "pi",
      command: [command],
      directory: scene.repository,
      folder: scene.directory,
      prompt: "text",
    }).ended;
    assert.equal(succeeded(end), true);
    assert.equal(end.result?.text, text);
    const entries = read(
      readFileSync(join(scene.directory, "turn.jsonl"), "utf8"),
    );
    assert.deepEqual(
      entries
        .filter((entry) => entry.kind === "assistant")
        .map((entry) => entry.text),
      [text],
    );
  }));

await test("CLV-364 Pi container input mounts only its decoder file read-only", () =>
  withScene(async (scene) => {
    const engine = fakeEngine(scene.directory, { access: "write" });
    const prompt = "\n" + "x".repeat(70_000) + "\n";
    const end = await startTurn({
      worker: "pi",
      command: [fakePi(scene), "--mode", "json"],
      directory: scene.repository,
      folder: scene.directory,
      prompt,
      runner: { kind: "container", engine: engine.path, image: "pi-fixture" },
    }).ended;
    assert.equal(succeeded(end), true);
    const observed = resultOf(
      readFileSync(join(scene.directory, "observed.json"), "utf8"),
    );
    assert.equal(observed["prompt"], prompt);
    const parts = observed["arguments"];
    assert.ok(Array.isArray(parts));
    const extension = String(parts[parts.indexOf("--extension") + 1]);
    const call = engine.calls()[0];
    assert.ok(Array.isArray(call));
    assert.ok(call.includes(`${extension}:${extension}:ro`));
    assert.equal(call.includes(`${extension}:${extension}`), false);
    assert.equal(
      resultOf(JSON.stringify(observed["environment"]))["GH_TOKEN"],
      undefined,
    );
    assert.deepEqual(observed["configuration"], []);
  }));

await test("CLV-364 Pi drains stdout and fails a truncated trailing record even after settlement", () =>
  withScene(async (scene) => {
    const output =
      piEvents()
        .map((event) => JSON.stringify(event) + "\n")
        .join("") + '{"type":"future_event"';
    const command = fakePi(scene, { output });
    const end = await startTurn({
      worker: "pi",
      command: [command],
      directory: scene.repository,
      folder: scene.directory,
      prompt: "text",
    }).ended;
    assert.equal(succeeded(end), false);
    assert.match(end.result?.text ?? "", /truncated.*LF/);
  }));

await test("CLV-364 Pi shell wrappers preserve arguments and strip GitHub credentials set by startup", () =>
  withScene(async (scene) => {
    const command = fakePi(scene);
    const startup = `export GH_TOKEN=secret\nexport GITHUB_TOKEN=secret\npi_function() { '${command}' "$@"; }\n`;
    writeFileSync(join(scene.directory, ".zshrc"), startup);
    const prompt = '--literal "quotes"\nline';
    const end = await startTurn({
      worker: "pi",
      shell: "/bin/zsh",
      command: ["pi_function", "--mode", "json"],
      directory: scene.repository,
      folder: scene.directory,
      prompt,
      environment: { ZDOTDIR: scene.directory },
    }).ended;
    assert.equal(succeeded(end), true);
    const observed = resultOf(
      readFileSync(join(scene.directory, "observed.json"), "utf8"),
    );
    assert.deepEqual(observed["arguments"], ["--mode", "json", "--", prompt]);
    const environment = resultOf(JSON.stringify(observed["environment"]));
    assert.equal(environment["GH_TOKEN"], undefined);
    assert.equal(environment["GITHUB_TOKEN"], undefined);
    assert.deepEqual(observed["configuration"], []);
  }));

await test("CLV-364 Pi shell input hooks retain whitespace and credential isolation", () =>
  withScene(async (scene) => {
    const command = fakePi(scene);
    writeFileSync(
      join(scene.directory, ".zshrc"),
      `export GH_TOKEN=secret\npi_function() { '${command}' "$@"; }\n`,
    );
    const prompt = "\n" + "x".repeat(70_000) + "\t\n";
    const end = await startTurn({
      worker: "pi",
      shell: "/bin/zsh",
      command: ["pi_function", "--mode", "json"],
      directory: scene.repository,
      folder: scene.directory,
      prompt,
      environment: { ZDOTDIR: scene.directory },
    }).ended;
    assert.equal(succeeded(end), true);
    const observed = resultOf(
      readFileSync(join(scene.directory, "observed.json"), "utf8"),
    );
    assert.equal(observed["prompt"], prompt);
    assert.equal(
      resultOf(JSON.stringify(observed["environment"]))["GH_TOKEN"],
      undefined,
    );
    assert.deepEqual(observed["configuration"], []);
  }));
