import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  prepareShellAttempt,
  releaseWorkflow,
  steps,
} from "./release-fixture.ts";

const mirrors = [
  "https://azure.archive.ubuntu.com/ubuntu",
  "https://archive.ubuntu.com/ubuntu",
  "https://mirrors.edge.kernel.org/ubuntu",
] as const;
const common = "zsh-common_5.9-6ubuntu2_all.deb";
const shell = "zsh_5.9-6ubuntu2_amd64.deb";

function fetched(name: string, tried: readonly string[]): string {
  return tried
    .map((mirror) => `curl ${name} ${mirror}/pool/main/z/zsh/${name}\n`)
    .join("");
}

const both =
  fetched(common, mirrors.slice(0, 1)) + fetched(shell, mirrors.slice(0, 1));
const checked = `${both}sha256sum\n`;
const installed = `${checked}dpkg -i ${common} ${shell}\n`;
const lastMirror = `${fetched(common, mirrors)}${fetched(shell, mirrors.slice(2))}sha256sum\ndpkg -i ${common} ${shell}\n`;

function listed(run: string, loop: RegExp): readonly string[] {
  return (loop.exec(run)?.[1] ?? "").trim().split(" ");
}

await test("CLV-266 Linux CI installs two pinned zsh packages from the first Ubuntu mirror that serves both, before setup, and propagates failures", async () => {
  const workflow = await releaseWorkflow();
  const linuxSteps = steps(workflow, "quality_linux_node");
  const prepare = linuxSteps.findIndex((step) => step.id === "prepare-shells");
  const setup = linuxSteps.findIndex(
    (step) => step.run === "npm run check:setup",
  );
  assert.ok(prepare >= 0 && prepare < setup, "Prepare zsh before setup");
  const folder = await mkdtemp(join(tmpdir(), "clv-266-zsh-"));
  const checkFile = join(folder, "checked");
  for (const [zsh, download, down, check, install, status, output] of [
    ["0", "0", "", "0", "0", 0, ""],
    ["1", "0", "", "0", "0", 0, installed],
    ["1", "22", "", "0", "0", 22, fetched(common, [...mirrors, ...mirrors])],
    ["1", "6", "", "0", "0", 6, fetched(common, [...mirrors, ...mirrors])],
    [
      "1",
      "0",
      "azure.archive.ubuntu.com archive.ubuntu.com",
      "0",
      "0",
      0,
      lastMirror,
    ],
    ["1", "0", "", "1", "0", 1, checked],
    ["1", "0", "", "0", "8", 8, installed],
  ] as const) {
    const result = prepareShellAttempt(workflow, {
      ZSH_STATUS: zsh,
      CURL_STATUS: download,
      CURL_DOWN: down,
      CHECK_STATUS: check,
      INSTALL_STATUS: install,
      CHECK_FILE: checkFile,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, output);
  }
  assert.match(
    await readFile(checkFile, "utf8"),
    /^56d160585b417af0cc04d7372f74a3b734609d7cc43ef8ea6e92bfdfc27f77c3 {2}\/\S+\/zsh-common_5\.9-6ubuntu2_all\.deb\nbd5cc8dd3a01a6db38c0a815d75202c356a9c7f378674ba7bed9bc86dcba8af0 {2}\/\S+\/zsh_5\.9-6ubuntu2_amd64\.deb\n$/,
  );
  await rm(folder, { recursive: true, force: true });
});

await test("CLV-266 the zsh step fits its time limit when each download of two passes over the mirrors hangs until its limit", async () => {
  const workflow = await releaseWorkflow();
  const step = steps(workflow, "quality_linux_node").find(
    (candidate) => candidate.id === "prepare-shells",
  );
  const run = step?.run ?? "";
  assert.doesNotMatch(run, /--retry/);
  assert.deepEqual(listed(run, /for mirror in ([^;]+);/), [...mirrors]);
  assert.equal(listed(run, /for attempt in ([^;]+);/).length, 2);
  const downloadSeconds = Number(listed(run, /--max-time (\d+)/)[0]);
  const worst = 2 * mirrors.length * 2 * downloadSeconds;
  const limit = (step?.["timeout-minutes"] ?? 0) * 60;
  assert.ok(
    worst + 60 <= limit,
    `downloads ${String(worst)} s, limit ${String(limit)} s`,
  );
});
