import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { DoctorScene } from "./doctor-fixture.ts";

export const agentSigner = `
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

export function git(scene: DoctorScene, parts: readonly string[]): string {
  return execFileSync("git", ["-C", scene.repository, ...parts], {
    encoding: "utf8",
  });
}

export function repositoryState(scene: DoctorScene): string {
  return [
    git(scene, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    git(scene, ["rev-parse", "HEAD"]),
    git(scene, ["status", "--porcelain"]),
  ].join("");
}

export async function signing(
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

export const agent = (scene: DoctorScene) => ({
  SSH_AUTH_SOCK: join(scene.root, "agent.sock"),
});
