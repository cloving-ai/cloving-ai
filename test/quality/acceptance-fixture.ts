import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { AcceptanceArtifact } from "../../quality/acceptance-artifacts.ts";
import type { AcceptanceEvidence } from "../../quality/acceptance.ts";
import type { StaticEvidence } from "../../quality/acceptance-evidence.ts";
import type {
  VerificationCommand,
  VerificationInputs,
} from "../../quality/verification-types.ts";
import type { VerifierInstallation } from "../../quality/verifier-installation.ts";
import { assembleAcceptancePlan } from "../../quality/acceptance-plan.ts";
import { executeVerification } from "../../quality/verification.ts";
import { activateVerifier } from "../../quality/verifier-activation.ts";
import { installVerifier } from "../../quality/verifier-installation.ts";
import { snapshotTree } from "../../quality/tree-snapshot.ts";
import { withFiles } from "./files-fixture.ts";

export const acceptancePlan = assembleAcceptancePlan({
  staticChecks: ["inventory", "lint"],
  diagnosticChecks: ["diagnostics"],
  minimumTests: 2,
  scenarios: ["fake-report", "added-source"],
  artifacts: ["typescript-output", "package-tarball", "workflow-handlers"],
  confinement: [],
});

export const passingTests =
  'import { test } from "node:test";\ntest("first", () => {});\ntest("second", () => {});\n';

const handlerFiles = [
  "client.mjs",
  "flow.mjs",
  "flow.mjs.__wf_tmp.js.debug.json",
  "steps.mjs",
  "steps.mjs.debug.json",
];
function handlerManifest(steps: Readonly<Record<string, string>>): string {
  return JSON.stringify({
    workflows: { "flow.ts": { run: { workflowId: "workflow-run" } } },
    steps: {
      "steps.ts": {
        effect: { stepId: "step-effect" },
        ...Object.fromEntries(
          Object.entries(steps).map(([name, stepId]) => [name, { stepId }]),
        ),
      },
    },
  });
}

export interface AcceptanceOptions {
  readonly tests?: string;
  readonly source?: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly packageJson?: string;
  readonly manifestSteps?: Readonly<Record<string, string>>;
  readonly contractSteps?: readonly string[];
}

export interface AcceptanceFixture {
  readonly root: string;
  readonly state: string;
  readonly candidate: string;
  readonly installed: VerifierInstallation;
  readonly command: VerificationCommand;
  readonly inventory: VerificationInputs;
  readonly evidence: AcceptanceEvidence;
}

export async function withAcceptance(
  options: AcceptanceOptions,
  inspect: (fixture: AcceptanceFixture) => Promise<void>,
): Promise<void> {
  await withFiles(await fixtureFiles(options), async (root) => {
    const installed = await activateFixture(root);
    const candidate = await realpath(join(root, "candidate"));
    const command = diagnosticCommand(installed, candidate);
    const inventory = diagnosticInventory(
      installed,
      candidate,
      Object.keys(options.files ?? {}),
    );
    const tree = (await snapshotTree(candidate)).identity;
    await inspect({
      root,
      state: join(root, "state"),
      candidate,
      installed,
      command,
      inventory,
      evidence: {
        candidate: tree,
        static: await staticFixture(installed, candidate, tree),
        diagnostics: await executeVerification(
          { requiredChecks: ["diagnostics"], commands: [command] },
          inventory,
        ),
        scenarios: acceptancePlan.scenarios.map((id) => ({
          id,
          outcome: "passed",
          verifier: installed.identity,
          candidate: tree,
        })),
        artifacts: await artifactFixture(
          root,
          candidate,
          options.contractSteps ?? Object.values(options.manifestSteps ?? {}),
        ),
      },
    });
  });
}

export async function packArchive(
  destination: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const entries = Object.entries(files).map(([name, content]) => {
    const bytes = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0);
    header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("0", 156);
    return Buffer.concat([
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    ]);
  });
  const archive = gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
  await writeFile(destination, archive);
  return createHash("sha256").update(archive).digest("hex");
}

async function activateFixture(root: string): Promise<VerifierInstallation> {
  const proposal = join(root, "proposal");
  const installed = await installVerifier(
    proposal,
    join(root, "installed"),
    (await snapshotTree(proposal)).identity,
  );
  const state = join(root, "state");
  await mkdir(state);
  await writeFile(
    join(state, "review.json"),
    JSON.stringify({
      decision: "approved",
      verifier: installed.identity,
      plan: acceptancePlan.identity,
      directory: installed.directory,
    }),
  );
  await activateVerifier(state, installed, acceptancePlan);
  return installed;
}

function diagnosticCommand(
  installed: VerifierInstallation,
  candidate: string,
): VerificationCommand {
  return {
    id: "diagnostics",
    executable: process.execPath,
    arguments: [
      "--test",
      "--test-concurrency=2",
      `--test-reporter=${join(installed.directory, "quality/test-reporter.ts")}`,
      join(candidate, "test/sample.test.ts"),
    ],
    directory: candidate,
    timeoutMilliseconds: 20000,
  };
}

function diagnosticInventory(
  installed: VerifierInstallation,
  candidate: string,
  files: readonly string[],
): VerificationInputs {
  return {
    source: [
      join(candidate, "src/index.ts"),
      ...files.map((file) => join(candidate, file)),
    ],
    tests: [join(candidate, "test/sample.test.ts")],
    dependencies: [join(candidate, "package.json")],
    tools: [
      process.execPath,
      join(installed.directory, "quality/test-reporter.ts"),
    ],
    policy: [join(installed.directory, "tools/check-protected-quality.ts")],
    exceptions: [],
  };
}

async function staticFixture(
  installed: VerifierInstallation,
  candidate: string,
  tree: string,
): Promise<StaticEvidence> {
  return {
    verifier: installed.identity,
    candidate: tree,
    role: "static-analysis",
    command: {
      id: "protected-quality",
      executable: await realpath(process.execPath),
      arguments: [
        join(installed.directory, "tools/check-protected-quality.ts"),
        candidate,
      ],
      directory: installed.directory,
      timeoutMilliseconds: 1000,
    },
    execution: {
      id: "protected-quality",
      processGroup: 1,
      exit: 0,
      signal: null,
      error: null,
      stdout: JSON.stringify({
        kind: "static-analysis",
        completed: acceptancePlan.staticChecks,
      }),
      stderr: "",
    },
  };
}

async function artifactFixture(
  root: string,
  candidate: string,
  contractSteps: readonly string[],
): Promise<readonly AcceptanceArtifact[]> {
  const tarball = join(root, "artifacts/package.tgz");
  return [
    {
      name: "typescript-output",
      path: join(candidate, "dist"),
      digest: (await snapshotTree(join(candidate, "dist"))).identity,
    },
    {
      name: "package-tarball",
      path: tarball,
      digest: await packArchive(tarball, {
        "package.json": await readFile(join(candidate, "package.json"), "utf8"),
        "dist/index.js": await readFile(
          join(candidate, "dist/index.js"),
          "utf8",
        ),
      }),
    },
    {
      name: "workflow-handlers",
      path: join(root, "artifacts/handlers"),
      digest: (await snapshotTree(join(root, "artifacts/handlers"))).identity,
      regenerated: join(root, "artifacts/regenerated"),
      contract: {
        workflows: ["workflow-run"],
        steps: ["step-effect", ...contractSteps],
      },
    },
  ];
}

async function fixtureFiles(
  options: AcceptanceOptions,
): Promise<Readonly<Record<string, string>>> {
  return {
    "proposal/tools/check-protected-quality.ts": "export {};",
    "proposal/quality/test-reporter.ts": await readFile(
      join(import.meta.dirname, "../../quality/test-reporter.ts"),
      "utf8",
    ),
    "candidate/package.json":
      options.packageJson ?? '{"name":"fixture","type":"module"}',
    ...Object.fromEntries(
      Object.entries(options.files ?? {}).map(([path, content]) => [
        `candidate/${path}`,
        content,
      ]),
    ),
    "candidate/src/index.ts": options.source ?? "export const value = 1;",
    "candidate/test/sample.test.ts": options.tests ?? passingTests,
    "candidate/dist/index.js": "export const value = 1;",
    ...Object.fromEntries(
      handlerFiles.flatMap((name) => [
        [`artifacts/handlers/${name}`, name],
        [`artifacts/regenerated/${name}`, name],
      ]),
    ),
    "artifacts/handlers/manifest.json": handlerManifest(
      options.manifestSteps ?? {},
    ),
    "artifacts/regenerated/manifest.json": handlerManifest(
      options.manifestSteps ?? {},
    ),
  };
}
