import { execFileSync } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

function commitFixture(repository: string): void {
  for (const argumentsList of [
    ["init", "-q"],
    ["add", "."],
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "Fixture",
    ],
  ])
    execFileSync("git", argumentsList, { cwd: repository, stdio: "pipe" });
}

export function withCleanRepository(
  gate: string,
  action: (fixture: {
    readonly repository: string;
    readonly temporary: string;
    readonly env: NodeJS.ProcessEnv;
  }) => void | Promise<void>,
): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cloving-clean-test-")));
  const repository = join(root, "repository");
  const temporary = join(root, "temporary");
  mkdirSync(join(repository, "tools"), { recursive: true });
  mkdirSync(join(repository, "test"));
  mkdirSync(join(repository, "node_modules"));
  mkdirSync(temporary);
  copyFileSync(
    new URL("../package.json", import.meta.url),
    join(repository, "package.json"),
  );
  const tool = new URL("../tools/check-clean.ts", import.meta.url);
  copyFileSync(tool, join(repository, "tools/check-clean.ts"));
  writeFileSync(join(repository, "tools/check-quality.ts"), gate);
  writeFileSync(
    join(repository, "test/required-input.test.ts"),
    `
import { readFileSync } from "node:fs";
import { test } from "node:test";
await test("requires build output", () => { readFileSync("dist/required-input.txt", "utf8"); });
`,
  );
  writeFileSync(join(repository, ".gitignore"), "node_modules/\ndist/\n");
  writeFileSync(
    join(repository, "node_modules/probe.txt"),
    "copied dependency",
  );
  commitFixture(repository);
  return Promise.resolve()
    .then(() =>
      action({
        repository,
        temporary,
        env: {
          ...process.env,
          TMPDIR: temporary,
          NODE_DISABLE_COMPILE_CACHE: "1",
        },
      }),
    )
    .finally(() => {
      rmSync(root, { recursive: true, force: true });
    });
}

export const reportingGate = `
import { readFileSync } from "node:fs";
console.log("clean-copy=" + process.cwd());
console.log(readFileSync("node_modules/probe.txt", "utf8"));
`;

export async function gateReady(
  child: ChildProcessByStdio<null, Readable, Readable>,
): Promise<number> {
  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    if (line.startsWith("gate-ready=")) {
      lines.close();
      return Number(line.slice("gate-ready=".length));
    }
  }
  throw new Error("gate-exited-before-ready");
}
