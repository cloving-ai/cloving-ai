import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createProbeRunner } from "../src/cli/probe-command.ts";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { check, withDoctor, type DoctorScene } from "./doctor-fixture.ts";
import {
  agent,
  agentSigner,
  git,
  repositoryState,
  signing,
} from "./doctor-signature-fixture.ts";

const fix =
  "Let turns commit with no signature: cloving config set turns.commitSignatures off --private. Or give turns the SSH agent: add SSH_AUTH_SOCK to turns.environment.";

await test("CLV-344 commit-signatures is a required check that gives ok when commit signatures are off", () =>
  withDoctor(async (scene) => {
    const shown = check(await scene.report(), "commit-signatures");
    assert.equal(shown["result"], "ok");
    assert.equal(shown["required"], true);
    assert.equal(shown["detail"], "Commit signatures are off");
    assert.equal(shown["fix"], fix);
  }));

await test("CLV-344 a turn without the SSH agent cannot sign, and the test signature changes no ref", () =>
  withDoctor(async (scene) => {
    await signing(scene, { format: "ssh", body: agentSigner });
    const before = repositoryState(scene);
    const output = await scene.report(agent(scene));
    const shown = check(output, "commit-signatures");
    assert.equal(shown["result"], "fail");
    assert.equal(
      shown["detail"],
      "A turn cannot sign commits (gpg.format ssh): error: signer: no SSH agent",
    );
    assert.equal(output.status, 1);
    assert.equal(repositoryState(scene), before);
  }));

await test("CLV-344 a turn with SSH_AUTH_SOCK in turns.environment can sign commits", () =>
  withDoctor(async (scene) => {
    await signing(scene, { format: "ssh", body: agentSigner });
    const before = repositoryState(scene);
    const shown = check(
      await scene.report({
        ...agent(scene),
        CLOVING_TURN_ENVIRONMENT: '["SSH_AUTH_SOCK"]',
      }),
      "commit-signatures",
    );
    assert.equal(shown["result"], "ok");
    assert.equal(shown["detail"], "A turn can sign commits (gpg.format ssh)");
    assert.equal(repositoryState(scene), before);
  }));

await test("CLV-344 turns.commitSignatures off gives ok with no test signature", () =>
  withDoctor(async (scene) => {
    await signing(scene, {
      format: "ssh",
      body: `${agentSigner}\nprocess.exit(70);`,
    });
    const file = privateSettingsPath(scene.environment, scene.repository);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ version: 1, turns: { commitSignatures: "off" } }),
    );
    const shown = check(await scene.report(), "commit-signatures");
    assert.equal(shown["result"], "ok");
    assert.equal(
      shown["detail"],
      "Turns commit with no signature (turns.commitSignatures off)",
    );
  }));

await test("CLV-344 a signer that does not end gives fail in less than 15 seconds", () =>
  withDoctor(async (scene) => {
    await signing(scene, {
      format: "ssh",
      body: "setTimeout(() => undefined, 60_000);",
    });
    const started = Date.now();
    const shown = check(await scene.report(agent(scene)), "commit-signatures");
    assert.ok(Date.now() - started < 15_000, String(Date.now() - started));
    assert.equal(shown["result"], "fail");
    assert.equal(
      shown["detail"],
      "A turn cannot sign commits (gpg.format ssh): the signature did not end in 10 seconds",
    );
  }));

await test("CLV-344 the default signature format is openpgp", () =>
  withDoctor(async (scene) => {
    await signing(scene, {
      format: "openpgp",
      body: 'process.stderr.write("\\ngpg: no secret key\\n"); process.exit(2);',
    });
    const shown = check(await scene.report(), "commit-signatures");
    assert.equal(shown["result"], "fail");
    assert.match(
      String(shown["detail"]),
      /^A turn cannot sign commits \(gpg\.format openpgp\): error: gpg failed to sign the data:?$/,
    );
  }));

await test("CLV-344 a commit.gpgsign value that git cannot read fails the check with the error of git", () =>
  withDoctor(async (scene) => {
    git(scene, ["config", "commit.gpgsign", "invalid"]);
    const shown = check(await scene.report(), "commit-signatures");
    assert.equal(shown["result"], "fail");
    assert.equal(
      shown["detail"],
      "A turn cannot read commit.gpgsign: fatal: bad boolean config value 'invalid' for 'commit.gpgsign'",
    );
  }));

await test("CLV-344 an invalid commit signature setting fails the check and names the variable", () =>
  withDoctor(async (scene) => {
    const shown = check(
      await scene.report({ CLOVING_TURN_COMMIT_SIGNATURES: "never" }),
      "commit-signatures",
    );
    assert.equal(shown["result"], "fail");
    assert.equal(
      shown["detail"],
      "invalid-setting: CLOVING_TURN_COMMIT_SIGNATURES",
    );
  }));

await test("CLV-344 an invalid turns.environment skips the test signature", () =>
  withDoctor(async (scene) => {
    const shown = check(
      await scene.report({ CLOVING_TURN_ENVIRONMENT: "all" }),
      "commit-signatures",
    );
    assert.equal(shown["result"], "skip");
    assert.equal(shown["detail"], "invalid-setting: CLOVING_TURN_ENVIRONMENT");
  }));

const engineBody = (log: string) => `
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] !== "run" || !args.includes("sh")) process.exit(0);
const environment = { PATH: process.env.PATH + ":/usr/bin:/bin" };
args.forEach((item, index) => {
  if (args[index - 1] !== "-e") return;
  const [name, ...value] = item.split("=");
  environment[name] = value.length > 0 ? value.join("=") : process.env[name];
});
const at = args.indexOf("sh");
if (args[at - 1] === "no-agent") delete environment.SSH_AUTH_SOCK;
if (args[at - 1] === "slow" && args.includes("commit-tree")) setTimeout(() => undefined, 60_000);
else process.exit(spawnSync(args[at], args.slice(at + 1), { cwd: args[args.indexOf("-w") + 1], env: environment, stdio: "inherit" }).status ?? 1);
`;

function words(line: string): readonly string[] {
  const value: unknown = JSON.parse(line);
  assert.ok(Array.isArray(value), line);
  return value.map(String);
}

async function profiledReport(
  scene: DoctorScene,
  profiles: Readonly<Record<string, unknown>>,
) {
  const file = join(scene.root, "profiles.json");
  await writeFile(file, JSON.stringify({ profiles }));
  return scene.report({
    ...agent(scene),
    CLOVING_TURN_ENVIRONMENT: '["SSH_AUTH_SOCK"]',
    CLOVING_PROFILES: file,
  });
}

await test("CLV-344 the check makes the test signature in the runner and environment of each profile, and names each profile that cannot sign", () =>
  withDoctor(async (scene) => {
    await signing(scene, { format: "ssh", body: agentSigner });
    const log = join(scene.root, "engine-calls");
    const engine = await scene.program("engine", engineBody(log));
    const box = (image: string) => ({
      runner: { kind: "container", engine, image },
    });
    const before = repositoryState(scene);
    const failed = check(
      await profiledReport(scene, {
        boxed: box("no-agent"),
        slow: box("slow"),
        open: box("agent"),
        plain: { model: "fixture" },
      }),
      "commit-signatures",
    );
    assert.equal(failed["result"], "fail");
    assert.equal(
      failed["detail"],
      "profile boxed: A turn cannot sign commits (gpg.format ssh): error: signer: no SSH agent; profile slow: A turn cannot sign commits (gpg.format ssh): the signature did not end in 10 seconds",
    );
    assert.equal(repositoryState(scene), before);
    const calls = (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map(words);
    const signed = calls.filter((call) => call.includes("commit-tree"));
    assert.deepEqual(
      signed.map((call) => call[call.indexOf("sh") - 1]),
      ["no-agent", "slow", "agent"],
    );
    const slow = signed[1] ?? [];
    assert.deepEqual(
      calls.filter((call) => call[0] === "rm"),
      [["rm", "-f", slow[slow.indexOf("--name") + 1]]],
    );
    const shown = check(
      await profiledReport(scene, {
        open: box("agent"),
        hosted: { runner: { kind: "host" }, env: { TZ: "UTC" } },
        plain: { runner: { kind: "host" } },
      }),
      "commit-signatures",
    );
    assert.equal(shown["result"], "ok");
    assert.equal(
      shown["detail"],
      "A turn can sign commits (gpg.format ssh); profile open: A turn can sign commits (gpg.format ssh); profile hosted: A turn can sign commits (gpg.format ssh)",
    );
  }));

await test("CLV-344 the check tests each profile runner and environment also when the default turn does not sign", () =>
  withDoctor(async (scene) => {
    await signing(scene, { format: "ssh", body: agentSigner });
    git(scene, ["config", "--unset", "commit.gpgsign"]);
    const global = join(scene.root, "signing.gitconfig");
    await writeFile(global, "[commit]\n\tgpgsign = true\n");
    const log = join(scene.root, "engine-calls");
    const engine = await scene.program("engine", engineBody(log));
    const box = (image: string, env: Readonly<Record<string, string>>) => ({
      runner: { kind: "container", engine, image },
      env,
    });
    const keyed = { GIT_CONFIG_GLOBAL: global };
    const shown = async (profiles: Readonly<Record<string, unknown>>) =>
      check(await profiledReport(scene, profiles), "commit-signatures");
    const failed = await shown({
      boxed: box("no-agent", keyed),
      open: box("agent", {}),
    });
    assert.equal(failed["result"], "fail");
    assert.equal(
      failed["detail"],
      "profile boxed: A turn cannot sign commits (gpg.format ssh): error: signer: no SSH agent",
    );
    const signed = await shown({ open: box("agent", keyed) });
    assert.equal(signed["result"], "ok");
    assert.equal(
      signed["detail"],
      "Commit signatures are off; profile open: A turn can sign commits (gpg.format ssh)",
    );
    const off = await shown({ open: box("agent", {}) });
    assert.equal(off["result"], "ok");
    assert.equal(off["detail"], "Commit signatures are off");
  }));

await test("CLV-344 a profiles file that is not valid skips the test signature", () =>
  withDoctor(async (scene) => {
    const file = join(scene.root, "profiles.json");
    await writeFile(file, '{"profiles":1}');
    const shown = check(
      await scene.report({ CLOVING_PROFILES: file }),
      "commit-signatures",
    );
    assert.equal(shown["result"], "skip");
    assert.equal(shown["detail"], "invalid-setting: profiles");
  }));

await test("CLV-344 the probe keeps the first error output and drops error output after its byte limit", async () => {
  const probe = createProbeRunner({
    spawn: (input) => spawn(input.executable, input.arguments, input.options),
    kill: (identifier, signal) => process.kill(identifier, signal),
  });
  const output = await probe(process.execPath, {
    arguments: [
      "-e",
      'process.stderr.write("first line\\n"); setTimeout(() => process.stderr.write("x".repeat(200_000)), 50);',
    ],
    env: {},
    bytes: 10,
  });
  const errors = output.stderr ?? "";
  assert.equal(output.reason, null);
  assert.ok(errors.startsWith("first line\n"), errors);
  assert.ok(errors.length < 200_011, String(errors.length));
});

await test("CLV-344 the README describes the check and both fixes, and lists the private setting", async () => {
  const readme = await readFile("README.md", "utf8");
  const start = readme.indexOf("### What a turn can reach");
  const reach = readme.slice(start, readme.indexOf("\n### ", start + 1));
  assert.match(reach, /required doctor check `commit-signatures`/);
  assert.match(
    reach,
    /let turns commit with no signature: `cloving config set turns\.commitSignatures off --private`/,
  );
  assert.match(reach, /add `SSH_AUTH_SOCK` to `turns\.environment`/);
  assert.doesNotMatch(
    readme,
    /A harness that signs commits with an SSH agent needs/,
  );
  assert.match(
    readme,
    /The private file supports [^\n]*`turns\.commitSignatures`/,
  );
  assert.match(readme, /The required `commit-signatures` check/);
  assert.match(
    readme,
    /the check runs git through the login shell of the turn/,
  );
  assert.match(readme, /reads only the output and the exit status of git/);
  assert.match(readme, /changes whether a turn starts through the login shell/);
});
