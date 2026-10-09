export interface VerifierInstallation {
  readonly directory: string;
  readonly identity: string;
}

export async function installVerifier(
  source: string,
  directory: string,
  identity: string,
): Promise<VerifierInstallation> {
  if ((await snapshotTree(source)).identity !== identity)
    throw new Error("unreviewed-verifier-inputs");
  const installed = await stageCandidate(source, directory);
  if (installed.identity !== identity) {
    await rm(installed.directory, { recursive: true });
    throw new Error("verifier-installation-changed");
  }
  return installed;
}

export async function assertVerifierInstallation(
  installation: VerifierInstallation,
): Promise<void> {
  const directory = await realpath(installation.directory);
  if (
    directory !== installation.directory ||
    (await snapshotTree(directory)).identity !== installation.identity
  )
    throw new Error("verifier-installation-changed");
}
import { realpath, rm } from "node:fs/promises";
import { stageCandidate } from "./staging.ts";
import { snapshotTree } from "./tree-snapshot.ts";
