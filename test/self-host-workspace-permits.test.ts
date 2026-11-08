import assert from "node:assert/strict";
import { test } from "node:test";
import { capturedSetting } from "./daemon-settings-capture.ts";
import { ended, scene, withoutChildren } from "./self-host-fixture.ts";

await test("CLV-312 the start program gives the daemon queue the permit socket of the workspace supervisor", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    const daemon = await fixture.start({
      CLOVING_WORKSPACE_PERMITS: "/workspace/permits.sock",
    });
    assert.equal(await ended(daemon), 0);
    assert.equal(
      capturedSetting({
        directory: fixture.directory,
        field: "workspacePermits",
      }),
      "/workspace/permits.sock",
    );
  }));
