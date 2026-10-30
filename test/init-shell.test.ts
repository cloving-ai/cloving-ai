import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { harnessStartRequest } from "../src/harness-start.ts";
import { withDoctor } from "./doctor-fixture.ts";

for (const shell of ["/bin/zsh", "/bin/bash"]) {
  for (const kind of ["function", "alias"]) {
    await test(`CLV-209 ${shell} ${kind} receives quoted message as one argument`, () =>
      withDoctor(async (scene) => {
        const file = await scene.program(
          "receiver",
          `import { writeFileSync } from "node:fs";
writeFileSync("received.json", JSON.stringify(process.argv.slice(2))); process.exit(7);`,
        );
        const definition =
          kind === "function"
            ? `custom() { "${file}" "$@"; }`
            : `alias custom='"${file}" --model fast'`;
        for (const name of [".zshrc", ".bash_profile"])
          await writeFile(join(scene.root, name), definition + "\n");
        const message =
          "run `cloving init-prompt` with \"quotes\" and 'apostrophes'; $(touch injected)";
        const request = harnessStartRequest(
          {
            name: "custom",
            kind: "shell",
            path: "custom",
          },
          {
            repository: scene.repository,
            environment: {
              ...scene.environment,
              SHELL: shell,
              ZDOTDIR: scene.root,
            },
            message,
          },
        );
        const result = spawnSync(request.executable, request.arguments, {
          cwd: request.directory,
          env: request.environment,
          stdio: "inherit",
        });
        assert.equal(result.status, 7);
        assert.deepEqual(
          JSON.parse(
            await readFile(join(scene.repository, "received.json"), "utf8"),
          ),
          kind === "function" ? [message] : ["--model", "fast", message],
        );
        await assert.rejects(readFile(join(scene.repository, "injected")), {
          code: "ENOENT",
        });
      }));
  }
}
