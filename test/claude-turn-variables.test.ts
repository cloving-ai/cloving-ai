import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { turn } from "./claude-profiles-fixture.ts";
import { withScene, type Scene } from "./claude-worker-fixture.ts";

function printer(scene: Scene): readonly string[] {
  const script = join(scene.directory, "variables-worker.mjs");
  writeFileSync(
    script,
    `for await (const chunk of process.stdin) String(chunk);
const names = ["SECRET_TEST_VALUE", "PROJECT_TEST_VALUE", "CLOVING_DEMO_TOOL"];
const env = Object.fromEntries(names.filter((name) => name in process.env).map((name) => [name, process.env[name]]));
console.log(JSON.stringify({ type: "result", is_error: false, result: JSON.stringify({ env }) }));
`,
  );
  return [process.execPath, script];
}

async function observed(
  variables: "inherit" | readonly string[] | undefined,
): Promise<unknown> {
  const saved = { ...process.env };
  process.env["SECRET_TEST_VALUE"] = "operator secret";
  process.env["PROJECT_TEST_VALUE"] = "project value";
  try {
    return await withScene(async (scene) => {
      const seen = await turn(scene, {
        method: "run-turn",
        settings: {
          command: printer(scene),
          ...(variables === undefined ? {} : { turnVariables: variables }),
        },
      });
      return seen["env"];
    });
  } finally {
    process.env = saved;
  }
}

await test("CLV-310 a worker turn does not get a daemon variable outside the allowlist", async () => {
  assert.deepEqual(await observed(undefined), {});
});

await test("CLV-310 a worker turn gets a daemon variable of turns.environment", async () => {
  assert.deepEqual(await observed(["PROJECT_TEST_VALUE"]), {
    PROJECT_TEST_VALUE: "project value",
  });
});

await test("CLV-315 a worker turn gets the demo tool path of the service", async () => {
  const saved = { ...process.env };
  process.env["CLOVING_DEMO_TOOL"] = "/tools/demo-video";
  try {
    assert.deepEqual(await observed(undefined), {
      CLOVING_DEMO_TOOL: "/tools/demo-video",
    });
  } finally {
    process.env = saved;
  }
});

await test("CLV-310 a worker turn with turns.environment inherit gets the whole environment", async () => {
  assert.deepEqual(await observed("inherit"), {
    SECRET_TEST_VALUE: "operator secret",
    PROJECT_TEST_VALUE: "project value",
  });
});
