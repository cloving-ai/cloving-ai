import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { nodeRefusal } from "../src/cli/node-refusal.ts";
import { check, withDoctor, type DoctorScene } from "./doctor-fixture.ts";

const refusal =
  "unsupported-node: Node v24.18.0. Cloving needs Node >=24.22.1 <25 || >=26.9.0 <27. Install a supported Node version: nvm install 26 && nvm use 26\n";

const refusedCommands = [
  ["start"],
  ["start", "-h"],
  ["init"],
  ["init", "--harness", "claude"],
  ["init-prompt"],
  ["status"],
  ["watch"],
  ["mcp"],
  ["config", "list"],
  ["phone", "pair"],
  ["themes", "list"],
  ["workflows", "list"],
  ["workflows", "validate", "workflow.json"],
  ["templates", "list"],
  ["red-green"],
  ["red-green", "-h"],
  ["integrations", "mcp"],
  ["run", "--prompt", "--help"],
  ["constructor"],
  ["unknown"],
];

const exemptCommands = [
  [],
  ["--help"],
  ["-h"],
  ["--version"],
  ["-v"],
  ["doctor"],
  ["doctor", "--json"],
  ["--repository", ".", "doctor"],
  ["init", "--help"],
  ["init-prompt", "--help"],
  ["doctor", "--help"],
  ["status", "--help"],
  ["watch", "--help"],
  ["mcp", "--help"],
  ["config", "--help"],
  ["phone", "--help"],
  ["themes", "--help"],
  ["workflows", "validate", "--help"],
  ["start", "--help"],
  ["workflows", "list", "--help"],
  ["workflows", "test", "-h"],
  ["templates", "--help"],
  ["templates", "list", "-h"],
  ["red-green", "--help"],
];

await test("CLV-343 an unsupported Node refuses each command except help, version and doctor", () => {
  for (const command of refusedCommands)
    assert.equal(nodeRefusal(command, "v24.18.0"), refusal, command.join(" "));
  for (const command of exemptCommands)
    assert.equal(
      nodeRefusal(command, "v24.18.0"),
      undefined,
      command.join(" "),
    );
  for (const version of ["v22.12.0", "v24.22.0", "v25.9.0", "v26.8.0"])
    assert.match(
      nodeRefusal(["init"], version) ?? "",
      new RegExp(`^unsupported-node: Node ${version}\\. `),
    );
});

await test("CLV-343 a supported Node refuses no command", () => {
  for (const version of ["v24.22.1", "v24.23.0", "v26.9.0", "v26.12.1"])
    for (const command of [...refusedCommands, ...exemptCommands])
      assert.equal(
        nodeRefusal(command, version),
        undefined,
        `${version} ${command.join(" ")}`,
      );
});

function nodeVersion(version: string): NodeJS.ProcessEnv {
  return {
    NODE_OPTIONS: `--import=data:text/javascript,Object.defineProperty(process,'version',{value:'${version}'})`,
  };
}

function cli(
  scene: DoctorScene,
  input: {
    readonly argumentsList: readonly string[];
    readonly version: string;
  },
) {
  return spawnSync(
    process.execPath,
    [resolve("src/cli.ts"), ...input.argumentsList],
    {
      cwd: scene.repository,
      env: { ...scene.environment, ...nodeVersion(input.version) },
      encoding: "utf8",
      timeout: 20000,
    },
  );
}

async function harness(scene: DoctorScene): Promise<string> {
  return scene.program(
    "fake",
    `if (process.argv[2] === "--version") console.log("1.0.0");
else {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("started.json", "{}");
  process.exit(7);
}`,
  );
}

await test("CLV-343 start and init on an unsupported Node write one line, exit 1 and start no service or harness", () =>
  withDoctor(async (scene) => {
    const fake = await harness(scene);
    for (const argumentsList of [["init", "--harness", fake], ["start"]]) {
      const result = cli(scene, { argumentsList, version: "v24.18.0" });
      assert.equal(result.status, 1, argumentsList.join(" "));
      assert.equal(result.stderr, refusal);
      assert.equal(result.stdout, "");
    }
    await assert.rejects(access(join(scene.repository, "started.json")), {
      code: "ENOENT",
    });
    await assert.rejects(access(join(scene.root, "state")), {
      code: "ENOENT",
    });
  }));

await test("CLV-343 version, help and doctor still run on an unsupported Node", () =>
  withDoctor(async (scene) => {
    const version = cli(scene, {
      argumentsList: ["--version"],
      version: "v24.18.0",
    });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
    const help = cli(scene, { argumentsList: ["--help"], version: "v24.18.0" });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^Usage: cloving/);
    const report = await scene.report(nodeVersion("v24.18.0"));
    assert.equal(check(report, "node-version")["result"], "fail");
    assert.match(
      String(check(report, "node-version")["detail"]),
      /^Node v24\.18\.0; /,
    );
  }));

await test("CLV-343 init on a supported Node starts the harness", () =>
  withDoctor(async (scene) => {
    const fake = await harness(scene);
    const result = cli(scene, {
      argumentsList: ["init", "--harness", fake],
      version: "v26.12.1",
    });
    assert.equal(result.status, 7, result.stderr);
    await access(join(scene.repository, "started.json"));
  }));

await test("CLV-343 the README names the supported Node versions and the unsupported-node stop", async () => {
  const readme = await readFile("README.md", "utf8");
  const section = (name: string) =>
    readme.split(`\n## ${name}\n`)[1]?.split("\n## ")[0] ?? "";
  for (const name of ["First run", "Install"]) {
    assert.match(
      section(name),
      /Node 24\.22\.1 or a later Node 24 version, or Node 26\.9\.0 or a later Node 26 version/,
      name,
    );
    assert.doesNotMatch(section(name), /ranges (?:of|in) `package\.json`/);
  }
  assert.match(
    section("Install"),
    /each command stops with `unsupported-node`/,
  );
  assert.match(
    section("Install"),
    /These commands still run: `cloving doctor`, `--help`, `--version` and the help of each command\./,
  );
});
