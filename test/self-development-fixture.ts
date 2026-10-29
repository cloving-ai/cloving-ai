import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { copyTemplate } from "../tools/template-copy.ts";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { fakeClaude, scene } from "./self-host-fixture.ts";
import { fakeGh, ghState } from "./github-worker-fixture.ts";

export const entry = join(candidatePackageRoot, "src/cli.ts");

export async function privateDevelop() {
  const fixture = await scene(
    fakeClaude.replace(
      "I added the file ticket-work.txt.",
      "I added the file ticket-work.txt.\\nTicket status: complete",
    ),
    entry,
  );
  const folder = join(fixture.root, "private-workflows");
  await copyTemplate({
    root: join(candidatePackageRoot, "templates"),
    name: "develop",
    id: "develop",
    folder,
    takenNames: new Set(),
  });
  const config = join(fixture.root, "config");
  const id = createHash("sha256").update(fixture.repository).digest("hex");
  await mkdir(join(config, "cloving/projects"), { recursive: true });
  await writeFile(
    join(config, "cloving/projects", `repository-${id.slice(0, 8)}.json`),
    JSON.stringify({ version: 1, workflows: { folder } }),
  );
  return { ...fixture, folder, config };
}

export async function privateQueue() {
  const fixture = await privateDevelop();
  const state = join(fixture.root, "gh-state.json");
  await writeFile(join(fixture.root, "fake-gh.mjs"), fakeGh);
  await writeFile(
    state,
    ghState({
      scores: [5, 5],
      issues: [900, 901].map((number) => ({
        repository: "acme/demo",
        number,
        state: "open",
        body: "Task.",
        labels: [],
      })),
    }),
  );
  await writeFile(
    join(fixture.root, "next.mjs"),
    'import { readFileSync } from "node:fs"; process.stdout.write(readFileSync(new URL("./ready", import.meta.url), "utf8"));',
  );
  await writeFile(
    join(fixture.root, "fake-board.mjs"),
    'const id = process.argv.at(-1); process.stdout.write("# Task " + id + "\\n\\nGitHub issue: acme/demo#" + id + " (open)\\n\\nDo the work.");',
  );
  return {
    ...fixture,
    state,
    environment: {
      XDG_CONFIG_HOME: fixture.config,
      CLOVING_QUEUE_SECONDS: "10",
      CLOVING_NEXT_COMMAND: JSON.stringify([
        process.execPath,
        join(fixture.root, "next.mjs"),
      ]),
      CLOVING_GH_COMMAND: JSON.stringify([
        process.execPath,
        join(fixture.root, "fake-gh.mjs"),
      ]),
      CLOVING_CHECK_COMMAND: JSON.stringify([process.execPath, "-e", ""]),
      CLOVING_PRIVATE_TEXTS: '["no such text"]',
      FAKE_GH_STATE: state,
      FAKE_GH_ORIGIN: fixture.origin,
    },
  };
}
