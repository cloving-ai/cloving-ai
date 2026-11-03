import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { withFiles } from "./quality/files-fixture.ts";
import { job, releaseWorkflow } from "./release-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const fakeGh = `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_DIRECTORY/calls"
case "$*" in
  *compare/*) printf '%s\\n' "$COMPARE_STATUS" ;;
  *actions/workflows/*)
    count=$(( $(cat "$FAKE_DIRECTORY/count" 2>/dev/null || echo 0) + 1 ))
    printf '%s' "$count" > "$FAKE_DIRECTORY/count"
    sed -n "\${count}p" "$FAKE_DIRECTORY/runs" ;;
esac
`;

async function mainCiAttempt(
  run: string,
  scenario: { readonly compare: string; readonly runs: readonly string[] },
) {
  return await withFiles({}, async (directory) => {
    await writeFile(join(directory, "gh"), fakeGh);
    await writeFile(join(directory, "sleep"), "#!/bin/bash\n");
    await chmod(join(directory, "gh"), 0o755);
    await chmod(join(directory, "sleep"), 0o755);
    await writeFile(join(directory, "runs"), scenario.runs.join("\n") + "\n");
    const result = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", run], {
      env: {
        PATH: `${directory}:/usr/bin:/bin`,
        FAKE_DIRECTORY: directory,
        COMPARE_STATUS: scenario.compare,
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_SHA: "0123456789abcdef",
        GH_TOKEN: "token",
      },
      encoding: "utf8",
      timeout: testMilliseconds(20000),
    });
    const calls = await readFile(join(directory, "calls"), "utf8");
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      calls,
    };
  });
}

await test("a version tag runs no second test run and requires the passed main CI of its commit", async () => {
  const workflow = await releaseWorkflow();
  const check = job(workflow, "release_check");
  assert.equal(check["runs-on"], "ubuntu-24.04");
  assert.equal(check["timeout-minutes"], 90);
  assert.equal(
    check.if,
    "${{ github.event_name == 'push' && github.ref_type == 'tag' && startsWith(github.ref, 'refs/tags/v') }}",
  );
  assert.deepEqual(check.permissions, { contents: "read", actions: "read" });
  assert.equal(check.needs, undefined);
  assert.equal(check.steps.length, 1);
  const [step] = check.steps;
  assert.equal(step?.id, "main-ci");
  assert.deepEqual(step.env, { GH_TOKEN: "${{ github.token }}" });
  const run = step.run;
  assert.ok(typeof run === "string");
  for (const [compare, runs, status] of [
    ["identical", ["completed success"], 0],
    ["behind", ["", "in_progress ", "queued ", "completed success"], 0],
    ["behind", ["completed failure"], 1],
    ["behind", ["in_progress ", "completed cancelled"], 1],
    ["behind", [], 1],
  ] as const) {
    const result = await mainCiAttempt(run, { compare, runs });
    assert.equal(
      result.status,
      status,
      `${compare} ${runs.join(",")}: ${result.output}`,
    );
    assert.match(
      result.calls,
      /repos\/owner\/repo\/compare\/main\.\.\.0123456789abcdef/,
    );
    assert.match(
      result.calls,
      /repos\/owner\/repo\/actions\/workflows\/ci\.yml\/runs\?event=push&branch=main&head_sha=0123456789abcdef/,
    );
  }
  for (const compare of ["ahead", "diverged"]) {
    const result = await mainCiAttempt(run, {
      compare,
      runs: ["completed success"],
    });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /is not on main/);
    assert.doesNotMatch(result.calls, /actions\/workflows/);
  }
});
