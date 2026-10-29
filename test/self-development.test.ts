import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { cli } from "./cli-workflows-fixture.ts";
import { ended, withoutChildren } from "./self-host-fixture.ts";
import { record } from "../src/protocol.ts";
import { entry, privateDevelop } from "./self-development-fixture.ts";

await test("CLV-227 start admits the default develop copy from private settings as the user queue", () =>
  withoutChildren(async () => {
    const fixture = await privateDevelop();
    const child = await fixture.start({ XDG_CONFIG_HOME: fixture.config });
    try {
      const declarations: unknown = JSON.parse(
        await readFile(
          join(fixture.directory, "project/declarations.json"),
          "utf8",
        ),
      );
      assert.ok(Array.isArray(declarations));
      const develop = declarations
        .map(record)
        .find((item) => item?.["workflowId"] === "develop");
      assert.equal(develop?.["queue"], true);
      const listed = cli(fixture.root, {
        args: ["list", "--json"],
        entry,
        directory: fixture.repository,
      });
      assert.equal(listed.status, 0, listed.stderr);
      const workflows: unknown = JSON.parse(listed.stdout);
      assert.ok(Array.isArray(workflows));
      const user = workflows
        .map(record)
        .find((item) => item?.["workflowId"] === "develop");
      assert.equal(user?.["scope"], "user");
      assert.equal(user["admitted"], true);
      const tested = cli(fixture.root, {
        args: ["test", "develop"],
        entry,
        directory: fixture.repository,
      });
      assert.equal(tested.status, 0, tested.stdout + tested.stderr);
    } finally {
      assert.equal(await ended(child), 0);
    }
  }));
