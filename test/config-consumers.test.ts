import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withGithub, opened } from "./github-worker-fixture.ts";
import { resultOf } from "./claude-worker-fixture.ts";
import { mergeCalls } from "./github-merge-fixture.ts";
import { settingsScene } from "./project-settings-fixture.ts";
import { withWatchService, watchReplies } from "./watch-service-fixture.ts";

await test("CLV-205 project required checks prevent merging with a missing check", () =>
  withGithub(async (scene) => {
    mkdirSync(join(scene.repository, ".cloving"));
    writeFileSync(
      join(scene.repository, ".cloving/config.json"),
      JSON.stringify({ version: 1, checks: { required: ["missing"] } }),
    );
    const worker = scene.worker({
      timing: {
        pollMilliseconds: 5,
        triggerMilliseconds: 10,
        limitMilliseconds: 20,
        ciGraceMilliseconds: 0,
        ciLimitMilliseconds: 100,
      },
    });
    const commit = await opened(scene, worker);
    scene.plan({
      scores: [],
      replies: { "api GET check-runs": [{ check_runs: [] }] },
    });
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(resultOf(report.result)["reason"], "ci-pending");
    assert.deepEqual(mergeCalls(scene), []);
  }));

await test("CLV-205 private watch actions disable the write endpoint in the watch process", async () => {
  const fixture = settingsScene();
  try {
    fixture.write(fixture.privateFile, {
      version: 1,
      watch: { actions: "off" },
    });
    await withWatchService(
      {
        answer: watchReplies({ runs: [], workflows: ["develop-prd"] }).answer,
        configure: () =>
          Promise.resolve({
            directory: fixture.repository,
            environment: {
              ...fixture.environment,
              CLOVING_WATCH_REPOSITORY: fixture.repository,
            },
          }),
      },
      async (watch) => {
        const response = await fetch(`${watch.address}actions/run`, {
          method: "POST",
          headers: { origin: new URL(watch.address).origin },
        });
        assert.equal(response.status, 404);
        const model: unknown = await (
          await fetch(`${watch.address}data.json`)
        ).json();
        assert.deepEqual(Reflect.get(Object(model), "cardForms"), []);
      },
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

import { readFile, mkdir, writeFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, basename } from "node:path";
import {
  configuredPrWatch,
  recordedPrJournal,
  ghRequest,
  stoppedPrRun,
} from "./watch-pr-cli-fixture.ts";
import { watchData } from "./watch-service-fixture.ts";

await test("CLV-205 watch reads its GitHub command from the private service-repository file", () =>
  withWatchService(
    {
      answer: watchReplies({ runs: [stoppedPrRun()] }).answer,
      configure: async (runtime) => {
        const options = await configuredPrWatch(runtime);
        const environment = options.environment ?? {};
        const repository = environment["CLOVING_WATCH_REPOSITORY"];
        assert.ok(repository);
        const command: unknown = JSON.parse(
          environment["CLOVING_GH_COMMAND"] ?? "null",
        );
        const id = createHash("sha256")
          .update(await realpath(repository))
          .digest("hex")
          .slice(0, 8);
        const config = join(dirname(runtime), "config");
        await mkdir(join(config, "cloving/projects"), { recursive: true });
        await writeFile(
          join(
            config,
            "cloving/projects",
            `${basename(repository)}-${id}.json`,
          ),
          JSON.stringify({ version: 1, github: { command } }),
        );
        await recordedPrJournal(runtime);
        return {
          ...options,
          environment: {
            CLOVING_WATCH_REPOSITORY: repository,
            XDG_CONFIG_HOME: config,
          },
        };
      },
    },
    async (watch, runtime) => {
      await watchData(watch.address);
      const request = await ghRequest(runtime);
      assert.ok(Array.isArray(request));
      assert.equal(request[0], "prefix with spaces");
      assert.ok(
        (await readFile(join(dirname(runtime), "gh-pid"), "utf8")).length > 0,
      );
    },
  ));
