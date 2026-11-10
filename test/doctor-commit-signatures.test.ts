import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createProbeRunner } from "../src/cli/probe-command.ts";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { check, withDoctor, type DoctorScene } from "./doctor-fixture.ts";

const fix =
  "Let turns commit with no signature: cloving config set turns.commitSignatures off --private. Or give turns the SSH agent: add SSH_AUTH_SOCK to turns.environment.";

const agentSigner = `
import { openSync, readFileSync, writeFileSync } from "node:fs";
const terminal = (() => { try { openSync("/dev/tty", "r"); return true; } catch { return false; } })();
if (terminal || readFileSync(0).length > 0) {
  process.stderr.write("signer: a terminal or an input is open\\n");
  process.exit(1);
}
if (process.env.SSH_AUTH_SOCK === undefined) {
  process.stderr.write("signer: no SSH agent\\nsecond line\\n");
  process.exit(1);
}
writeFileSync(process.argv.at(-1) + ".sig", "-----BEGIN SSH SIGNATURE-----\\nZml4dHVyZQ==\\n-----END SSH SIGNATURE-----\\n");
`;

function git(scene: DoctorScene, parts: readonly string[]): string {
  return execFileSync("git", ["-C", scene.repository, ...parts], {
    encoding: "utf8",
  });
}

function repositoryState(scene: DoctorScene): string {
  return [
    git(scene, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    git(scene, ["rev-parse", "HEAD"]),
    git(scene, ["status", "--porcelain"]),
  ].join("");
}

async function signing(
  scene: DoctorScene,
  signer: { readonly format: "ssh" | "openpgp"; readonly body: string },
): Promise<void> {
  git(scene, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);
  const program = await scene.program("signer", signer.body);
  for (const [key, value] of [
    ["user.name", "Fixture"],
    ["user.email", "fixture@example.test"],
    ["commit.gpgsign", "true"],
    ["user.signingkey", "key::ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixture"],
    ...(signer.format === "ssh"
      ? [
          ["gpg.format", "ssh"],
          ["gpg.ssh.program", program],
        ]
      : [["gpg.program", program]]),
  ])
    git(scene, ["config", key ?? "", value ?? ""]);
}

const agent = (scene: DoctorScene) => ({
  SSH_AUTH_SOCK: join(scene.root, "agent.sock"),
});

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
    assert.equal(
      shown["detail"],
      "A turn cannot sign commits (gpg.format openpgp): error: gpg failed to sign the data:",
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
});
