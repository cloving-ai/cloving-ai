import assert from "node:assert/strict";
import { test } from "node:test";
import { recordsJsonWorld } from "../src/world-storage.ts";

function recorded(...manifests: readonly string[]): string {
  return JSON.stringify({
    packages: manifests.map((manifest) => ({ manifest, dependencies: {} })),
  });
}

function world(version: string): string {
  return JSON.stringify({ name: "@workflow/world-local", version });
}

await test("#852 a bundle dependency record names the JSON Local World only for a Local World release before 5.4.0", () => {
  assert.deepEqual(
    ["4.9.0", "5.0.2", "5.3.9", "5.4.0", "5.4.1", "6.0.0", "bundled"].map(
      (version) => recordsJsonWorld(recorded(world(version))),
    ),
    [true, true, true, false, false, false, false],
  );
  assert.deepEqual(
    [
      "{}",
      "not json",
      "null",
      JSON.stringify({ packages: "none" }),
      JSON.stringify({ packages: [null, "manifest", 5, { manifest: 5 }] }),
      recorded(JSON.stringify("@workflow/world-local")),
      recorded(JSON.stringify({ name: "@workflow/world-local", version: 5 })),
      recorded(
        "not json",
        JSON.stringify({ name: "workflow", version: "5.1.0" }),
      ),
      recorded(
        JSON.stringify({ name: "workflow", version: "5.1.0" }),
        world("5.0.2"),
      ),
    ].map((dependencies) => recordsJsonWorld(dependencies)),
    [false, false, false, false, false, false, false, false, true],
  );
});
