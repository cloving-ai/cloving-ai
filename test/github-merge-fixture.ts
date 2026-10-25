import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { git, journalKey } from "./claude-worker-fixture.ts";
import { committed, type GithubScene } from "./github-worker-fixture.ts";

export function advancedBase(scene: GithubScene): string {
  const base = committed(scene.repository, { name: "base.ts", text: "2;\n" });
  git(scene.repository, ["push", "--quiet", "origin", "main"]);
  return base;
}

export function movingCheck(
  scene: GithubScene,
  limit: number,
): readonly string[] {
  return [
    process.execPath,
    "-e",
    `
    const fs = require("node:fs");
    const { execFileSync } = require("node:child_process");
    const marker = ${JSON.stringify(join(scene.directory, "checks"))};
    const count = fs.existsSync(marker) ? Number(fs.readFileSync(marker, "utf8")) : 0;
    fs.writeFileSync(marker, String(count + 1));
    if (count < ${String(limit)}) {
      const cwd = ${JSON.stringify(scene.repository)};
      const git = (args) => execFileSync("git", args, { cwd });
      git(["commit", "--quiet", "--allow-empty", "-m", "Move the base " + count]);
      git(["push", "--quiet", "origin", "main"]);
    }
  `,
  ];
}

export function mergeCalls(scene: GithubScene): readonly (readonly string[])[] {
  return scene.state().calls.filter((call) => call.includes("PUT"));
}

export function leftMerge(scene: GithubScene, commit: string): string {
  const folder = join(scene.journal, journalKey("merge-left"));
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "started.json"),
    JSON.stringify({
      operationId: "merge-left",
      runId: "run-1",
      inputDigest: "sha256:input",
      leaseGeneration: 1,
      method: "merge",
      target: "ticket/one",
      payloadText: JSON.stringify({ number: 1, commit }),
    }),
  );
  return folder;
}

export function pausedMerge(scene: GithubScene): readonly string[] {
  const script = join(scene.directory, "pause-merge.mjs");
  writeFileSync(
    script,
    `
    import { writeFileSync } from "node:fs";
    import { execFileSync } from "node:child_process";
    const args = process.argv.slice(2);
    if (args.some((arg) => arg.endsWith("/merge"))) {
      writeFileSync(${JSON.stringify(join(scene.directory, "paused"))}, "paused");
      setTimeout(() => process.exit(1), 60000);
    } else {
      process.stdout.write(execFileSync(process.execPath, [${JSON.stringify(join(scene.directory, "fake-gh.mjs"))}, ...args]));
    }
  `,
  );
  return ["env", "-u", "NODE_V8_COVERAGE", process.execPath, script];
}
