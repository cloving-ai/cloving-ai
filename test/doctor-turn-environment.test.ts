import assert from "node:assert/strict";
import { test } from "node:test";
import { turnEnvironmentObservation } from "../src/cli/doctor-turns.ts";
import { check, withDoctor } from "./doctor-fixture.ts";

const daemon = {
  SECRET_TEST_VALUE: "operator secret value",
  PROJECT_TEST_VALUE: "project value",
  ANTHROPIC_API_KEY: "claude login value",
  OPENAI_API_KEY: "codex login value",
  GH_TOKEN: "test-credential",
};

await test("CLV-310 doctor names the variables that a turn does not get, with no values", () =>
  withDoctor(async (scene) => {
    const shown = check(await scene.report(daemon), "turn-environment");
    assert.equal(shown["result"], "ok");
    assert.equal(shown["required"], false);
    const detail = String(shown["detail"]);
    assert.match(
      detail,
      /^A turn does not get \d+ variables? of the service environment: /,
    );
    const names = detail.split(": ")[1]?.split(", ") ?? [];
    assert.ok(names.includes("SECRET_TEST_VALUE"), detail);
    assert.ok(names.includes("PROJECT_TEST_VALUE"), detail);
    assert.ok(names.includes("OPENAI_API_KEY"), detail);
    assert.deepEqual(names, [...names].sort());
    for (const hidden of [
      "ANTHROPIC_API_KEY",
      "GH_TOKEN",
      "PATH",
      "HOME",
      "CLOVING_",
      "value",
      "test-credential",
    ])
      assert.ok(!detail.includes(hidden), `${hidden} in ${detail}`);
    assert.equal(
      shown["fix"],
      `Give a turn a variable that the project needs: cloving config set turns.environment '["NAME"]' --private`,
    );
  }));

await test("CLV-310 doctor does not name a variable of turns.environment or of the selected harness login", () =>
  withDoctor(async (scene) => {
    const shown = check(
      await scene.report({
        ...daemon,
        CLOVING_WORKER: "codex",
        CLOVING_TURN_ENVIRONMENT: '["PROJECT_TEST_VALUE"]',
      }),
      "turn-environment",
    );
    const detail = String(shown["detail"]);
    assert.ok(detail.includes("SECRET_TEST_VALUE"), detail);
    assert.ok(detail.includes("ANTHROPIC_API_KEY"), detail);
    assert.ok(!detail.includes("PROJECT_TEST_VALUE"), detail);
    assert.ok(!detail.includes("OPENAI_API_KEY"), detail);
  }));

await test("CLV-310 doctor warns when turns.environment is inherit", () =>
  withDoctor(async (scene) => {
    const shown = check(
      await scene.report({ ...daemon, CLOVING_TURN_ENVIRONMENT: "inherit" }),
      "turn-environment",
    );
    assert.equal(shown["result"], "warn");
    assert.equal(
      shown["detail"],
      "turns.environment is inherit: a turn gets all variables of the service environment except the GitHub tokens",
    );
  }));

await test("CLV-310 an invalid turns.environment fails the optional doctor check and names the variable", () =>
  withDoctor(async (scene) => {
    const shown = check(
      await scene.report({ CLOVING_TURN_ENVIRONMENT: "all" }),
      "turn-environment",
    );
    assert.equal(shown["result"], "fail");
    assert.equal(shown["required"], false);
    assert.equal(shown["detail"], "invalid-setting: CLOVING_TURN_ENVIRONMENT");
  }));

await test("CLV-310 the doctor text counts one variable or none", () => {
  assert.deepEqual(
    turnEnvironmentObservation({ PATH: "/bin", SECRET_TEST_VALUE: "secret" }),
    {
      result: "ok",
      detail:
        "A turn does not get 1 variable of the service environment: SECRET_TEST_VALUE",
    },
  );
  assert.deepEqual(turnEnvironmentObservation({ PATH: "/bin" }), {
    result: "ok",
    detail:
      "A turn gets all variables of the service environment except the GitHub tokens",
  });
});
