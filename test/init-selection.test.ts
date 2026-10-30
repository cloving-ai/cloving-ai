import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { withDoctor } from "./doctor-fixture.ts";
import { initCli } from "./init-fixture.ts";

await test("CLV-209 init needs a repository and suggests git init", () =>
  withDoctor((scene) => {
    const result = initCli(scene, {
      directory: scene.root,
      arguments: ["--harness", "codex"],
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not-a-repository.*git init/);
  }));

await test("CLV-209 init needs an explicit harness without a terminal", () =>
  withDoctor((scene) => {
    const result = initCli(scene);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /harness-not-selected/);
  }));

await test("CLV-209 init refuses unusable harnesses without starting them", () =>
  withDoctor(async (scene) => {
    const file = await scene.program(
      "broken",
      'console.log("Error: unavailable")',
    );
    for (const harness of [file, "missing", "shell:missing"]) {
      const result = initCli(scene, { arguments: ["--harness", harness] });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /harness-unusable/);
    }
  }));

await test("CLV-209 init refuses an ambiguous name and shell:codex selects the function", () =>
  withDoctor(async (scene) => {
    await writeFile(
      join(scene.root, ".zshrc"),
      'codex() { if [ "$1" = --version ]; then printf "codex-cli 1.0.0\\n"; else printf "%s" "$1" > "$HOME/message"; return 7; fi; }\n',
    );
    const environment = { SHELL: "/bin/zsh", ZDOTDIR: scene.root };
    const ambiguous = initCli(scene, {
      arguments: ["--harness", "codex"],
      environment,
    });
    assert.equal(ambiguous.status, 2);
    assert.match(ambiguous.stderr, /harness-ambiguous/);
    const selected = initCli(scene, {
      arguments: ["--harness", "shell:codex"],
      environment,
    });
    assert.equal(selected.status, 7, selected.stderr);
    assert.equal(
      await readFile(join(scene.root, "message"), "utf8"),
      "run `cloving init-prompt`",
    );
  }));

await test("CLV-209 opencode starts with --prompt and no permission flags", () =>
  withDoctor(async (scene) => {
    await scene.program(
      "opencode",
      `if (process.argv[2] === "--version") console.log("1.2.0");
else { console.log(JSON.stringify(process.argv.slice(2))); }`,
    );
    const result = initCli(scene, { arguments: ["--harness", "opencode"] });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      "--prompt",
      "run `cloving init-prompt`",
    ]);
  }));

await test("CLV-209 start failure prints manual fallback and exits one", () =>
  withDoctor(async (scene) => {
    const file = await scene.program(
      "vanishing",
      `import { unlinkSync } from "node:fs";
unlinkSync(process.argv[1]); console.log("1.0.0");`,
    );
    const result = initCli(scene, { arguments: ["--harness", file] });
    assert.equal(result.status, 1);
    assert.ok(
      result.stderr.includes(
        "Open your agent in this repository and tell it: run `cloving init-prompt`.",
      ),
    );
  }));

await test("CLV-209 custom harness names use the default start form even for object property names", () =>
  withDoctor(async (scene) => {
    for (const name of ["constructor", "__proto__", "toString"]) {
      const file = await scene.program(
        name,
        'if (process.argv[2] === "--version") console.log("1.0.0"); else console.log(JSON.stringify(process.argv.slice(2)));',
      );
      const result = initCli(scene, { arguments: ["--harness", file] });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [
        "run `cloving init-prompt`",
      ]);
    }
  }));

await test("CLV-209 init starts executable paths whose basenames contain spaces and an extension", () =>
  withDoctor(async (scene) => {
    const file = await scene.program(
      "My Agent.sh",
      'if (process.argv[2] === "--version") console.log("1.0.0"); else console.log(JSON.stringify(process.argv.slice(2)));',
    );
    const result = initCli(scene, { arguments: ["--harness", file] });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["run `cloving init-prompt`"]);
  }));

await test("CLV-209 a shell function removed after probing prints the start fallback", () =>
  withDoctor(async (scene) => {
    await writeFile(
      join(scene.root, ".bash_profile"),
      'custom() { /bin/rm "$HOME/.bash_profile"; printf "1.0.0\\n"; }\n',
    );
    const result = initCli(scene, {
      arguments: ["--harness", "shell:custom"],
      environment: { SHELL: "/bin/bash" },
    });
    assert.equal(result.status, 1);
    assert.ok(
      result.stderr.includes(
        "Open your agent in this repository and tell it: run `cloving init-prompt`.",
      ),
    );
  }));

for (const kind of ["function", "alias"]) {
  await test(`CLV-209 init starts a Bash ${kind} from the interactive mode that passed probing`, () =>
    withDoctor(async (scene) => {
      const file = await scene.program(
        "receiver",
        'if (process.argv[2] === "--version") console.log("1.0.0"); else { console.log(JSON.stringify(process.argv.slice(2))); process.exit(7); }',
      );
      await writeFile(
        join(scene.root, ".bash_profile"),
        'custom() { printf "Error: unavailable\\n"; }\n',
      );
      await writeFile(
        join(scene.root, ".bashrc"),
        kind === "function"
          ? `custom() { "${file}" "$@"; }\n`
          : `alias custom='"${file}"'\n`,
      );
      const result = initCli(scene, {
        arguments: ["--harness", "shell:custom"],
        environment: { SHELL: "/bin/bash" },
      });
      assert.equal(result.status, 7, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [
        "run `cloving init-prompt`",
      ]);
    }));
}

await test("CLV-209 a custom OpenCode executable keeps the generic start form", () =>
  withDoctor(async (scene) => {
    const file = await scene.program(
      "OpenCode",
      'if (process.argv[2] === "--version") console.log("1.0.0"); else console.log(JSON.stringify(process.argv.slice(2)));',
    );
    const result = initCli(scene, { arguments: ["--harness", file] });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["run `cloving init-prompt`"]);
  }));
