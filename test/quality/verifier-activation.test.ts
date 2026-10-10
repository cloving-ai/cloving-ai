import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { assembleAcceptancePlan } from "../../quality/acceptance-plan.ts";
import {
  activateVerifier,
  readVerifierActivation,
} from "../../quality/verifier-activation.ts";
import { installVerifier } from "../../quality/verifier-installation.ts";
import { snapshotTree } from "../../quality/tree-snapshot.ts";
import { withFiles } from "./files-fixture.ts";

const plan = assembleAcceptancePlan({
  staticChecks: ["lint"],
  diagnosticChecks: ["diagnostics"],
  minimumTests: 1,
  scenarios: ["fake-report"],
  artifacts: ["package"],
  confinement: [],
});

async function withInstalledVerifier(
  inspect: (
    root: string,
    installed: { directory: string; identity: string },
  ) => Promise<void>,
): Promise<void> {
  await withFiles(
    { "proposal/check.ts": "export const limit = 400;" },
    async (root) => {
      const proposal = join(root, "proposal");
      const installed = await installVerifier(proposal, {
        directory: join(root, "installed"),
        identity: (await snapshotTree(proposal)).identity,
      });
      await mkdir(join(root, "state"));
      await inspect(root, installed);
    },
  );
}

async function review(
  root: string,
  approved: { verifier: string; plan: string; directory: string },
): Promise<void> {
  await writeFile(
    join(root, "state/review.json"),
    JSON.stringify({ decision: "approved", ...approved }),
  );
}

await test("QG-12 activation binds the installed verifier, plan and protected review", async () => {
  await withInstalledVerifier(async (root, installed) => {
    await review(root, {
      verifier: installed.identity,
      plan: plan.identity,
      directory: installed.directory,
    });
    const activation = await activateVerifier(join(root, "state"), {
      installation: installed,
      plan,
    });
    assert.equal(activation.verifier.identity, installed.identity);
    assert.equal(activation.plan.identity, plan.identity);
    assert.deepEqual(
      await readVerifierActivation(join(root, "state")),
      activation,
    );
  });
});

await test("QG-12 repository proposals and caller digests cannot activate themselves", async () => {
  await withInstalledVerifier(async (root, installed) => {
    const state = join(root, "state");
    await assert.rejects(
      activateVerifier(state, { installation: installed, plan }),
      /unreviewed-verifier-activation/,
    );
    await writeFile(join(root, "proposal/check.ts"), "export const limit = 0;");
    const proposal = (await snapshotTree(join(root, "proposal"))).identity;
    await review(root, {
      verifier: proposal,
      plan: plan.identity,
      directory: installed.directory,
    });
    await assert.rejects(
      activateVerifier(state, { installation: installed, plan }),
      /unreviewed-verifier-activation/,
    );
    await assert.rejects(
      activateVerifier(state, {
        installation: { ...installed, identity: proposal },
        plan,
      }),
      /verifier-installation-changed/,
    );
    await review(root, {
      verifier: installed.identity,
      plan: "caller-digest",
      directory: installed.directory,
    });
    await assert.rejects(
      activateVerifier(state, { installation: installed, plan }),
      /unreviewed-verifier-activation/,
    );
    await review(root, {
      verifier: installed.identity,
      plan: plan.identity,
      directory: installed.directory,
    });
    await assert.rejects(
      activateVerifier(state, {
        installation: installed,
        plan: { ...plan, minimumTests: 0 },
      }),
      /invalid-acceptance-plan/,
    );
    await review(root, {
      verifier: installed.identity,
      plan: plan.identity,
      directory: join(root, "proposal"),
    });
    await assert.rejects(
      activateVerifier(state, { installation: installed, plan }),
      /unreviewed-verifier-activation/,
    );
    await assert.rejects(access(join(state, "activation.json")), /ENOENT/);
  });
});

await test("QG-12 activation is never overwritten and later changes invalidate it", async () => {
  await withInstalledVerifier(async (root, installed) => {
    const state = join(root, "state");
    await review(root, {
      verifier: installed.identity,
      plan: plan.identity,
      directory: installed.directory,
    });
    await activateVerifier(state, { installation: installed, plan });
    await assert.rejects(
      activateVerifier(state, { installation: installed, plan }),
      /verifier-activation-exists/,
    );
    await writeFile(join(state, "review.json"), "{}");
    await assert.rejects(
      readVerifierActivation(state),
      /unreviewed-verifier-activation/,
    );
    await review(root, {
      verifier: installed.identity,
      plan: plan.identity,
      directory: installed.directory,
    });
    await writeFile(
      join(installed.directory, "check.ts"),
      "export const limit = 0;",
    );
    await assert.rejects(
      readVerifierActivation(state),
      /verifier-installation-changed/,
    );
  });
});

await test("QG-12 a malformed activation record is not active", async () => {
  await withInstalledVerifier(async (root, installed) => {
    const state = join(root, "state");
    await review(root, {
      verifier: installed.identity,
      plan: plan.identity,
      directory: installed.directory,
    });
    await activateVerifier(state, { installation: installed, plan });
    for (const record of [
      "[]",
      JSON.stringify({ identity: "x", review: "y", verifier: {}, plan }),
      JSON.stringify({
        identity: "x",
        review: "y",
        verifier: installed,
        plan: { ...plan, scenarios: [1] },
      }),
    ]) {
      await rm(join(state, "activation.json"));
      await writeFile(join(state, "activation.json"), record);
      await assert.rejects(
        readVerifierActivation(state),
        /invalid-verifier-activation/,
      );
    }
  });
});

await test("QG-12 a rewritten activation must still match its review", async () => {
  await withInstalledVerifier(async (root, installed) => {
    const state = join(root, "state");
    await review(root, {
      verifier: installed.identity,
      plan: plan.identity,
      directory: installed.directory,
    });
    const activation = await activateVerifier(state, {
      installation: installed,
      plan,
    });
    const weakened = assembleAcceptancePlan({
      ...plan,
      minimumTests: 1,
      scenarios: ["other"],
    });
    const record = {
      verifier: activation.verifier,
      plan: weakened,
      review: activation.review,
    };
    await rm(join(state, "activation.json"));
    await writeFile(
      join(state, "activation.json"),
      JSON.stringify({
        identity: createHash("sha256")
          .update(JSON.stringify(record))
          .digest("hex"),
        ...record,
      }),
    );
    await assert.rejects(
      readVerifierActivation(state),
      /unreviewed-verifier-activation/,
    );
  });
});
