import assert from "node:assert/strict";
import { test } from "node:test";
import { readReportGithub } from "../src/cli/report-github.ts";
import {
  githubReportFixture as fixture,
  since,
  output,
} from "./report-github-fixture.ts";

await test("CLV-199 one bare HTTP 503 reply retries a GET and then reports readable data", async () => {
  const scene = fixture({
    failures: [{ ...output(null), status: 1, stderr: "gh: HTTP 503\n" }],
  });
  const result = await readReportGithub({
    since,
    retryMilliseconds: 1,
    settings: scene.settings,
  });
  assert.deepEqual(result.issues, []);
  assert.equal(scene.attempts(), 2);
});
