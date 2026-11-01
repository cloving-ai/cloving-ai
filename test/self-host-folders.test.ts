import assert from "node:assert/strict";
import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { call } from "./service-fixture.ts";
import { ended, scene, withoutChildren } from "./self-host-fixture.ts";
import {
  operatorFiles,
  operatorRefusals,
  runOperator,
} from "./operator-startup-fixture.ts";

await test("CLV-124 real daemon startup registers admitted operator snapshots and reports refused neighbors", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    const files = await operatorFiles(fixture);
    const alias = join(fixture.root, "repository-alias");
    await symlink(fixture.repository, alias);
    const daemon = await fixture.start(
      {
        CLOVING_SELF_UPDATE_SECONDS: undefined,
        XDG_CONFIG_HOME: join(fixture.root, "config"),
      },
      ["--repository", alias],
    );
    try {
      const listed = await call(fixture, {
        operation: "status",
        parameters: {},
      });
      assert.deepEqual(listed["workflowRefusals"], operatorRefusals);
      assert.deepEqual(listed["workflows"], ["project-run", "user-run"]);
      assert.deepEqual(listed["runs"], []);
      assert.doesNotMatch(JSON.stringify(listed), /SOURCE_SENTINEL/);
      await runOperator(fixture, "project-run");
      await runOperator(fixture, "user-run");
      const refused = await call(fixture, {
        operation: "run",
        parameters: {
          workflowId: "refused",
          source: "declared",
          commandId: "refused",
          submission: {},
        },
      });
      assert.equal(refused["kind"], "error");
      assert.equal(refused["code"], "unknown-workflow");
      for (const [name, bytes] of Object.entries(files))
        assert.equal(await readFile(name, "utf8"), bytes);
    } finally {
      assert.equal(await ended(daemon), 0);
    }
  }));
