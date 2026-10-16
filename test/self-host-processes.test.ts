import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { hostedPrograms } from "../tools/self-host-processes.ts";
import { withUpdateRepository } from "./self-update-git-fixture.ts";

async function programs(
  root: string,
  options: { readonly daemonMilliseconds?: number } = {},
): Promise<{ readonly product: string; readonly project: string }> {
  const product = join(root, "product");
  const project = join(root, "project");
  await mkdir(join(product, "src"), { recursive: true });
  await mkdir(project);
  const program = (name: string): string => `
import { writeFileSync } from "node:fs";
const timer = setInterval(() => {}, 1000);
process.on("SIGTERM", () => setTimeout(() => {
  writeFileSync(${JSON.stringify(join(root, `${name}-stopped`))}, "stopped");
  clearInterval(timer);
}, 50));
writeFileSync(${JSON.stringify(join(root, `${name}-ready`))}, "ready");
${name === "daemon" && options.daemonMilliseconds ? `setTimeout(() => process.emit("SIGTERM"), ${String(options.daemonMilliseconds)});` : ""}
`;
  await writeFile(join(project, "start.mjs"), program("daemon"));
  await writeFile(join(product, "src/cli.ts"), program("watch"));
  return { product, project };
}

await test("CLV-085 the host stops and awaits daemon and watch before fast-forwarding", async () => {
  await withUpdateRepository(async ({ root, repository, git, target }) => {
    const paths = await programs(root);
    const status = await hostedPrograms({
      ...paths,
      repository,
      runtime: join(root, "host/run"),
      directory: join(root, "host"),
      watchPort: "3663",
      updateMilliseconds: 300,
    });
    assert.equal(status, 75);
    assert.equal(git(["rev-parse", "HEAD"]), target);
    assert.equal(
      await readFile(join(root, "daemon-stopped"), "utf8"),
      "stopped",
    );
    assert.equal(
      await readFile(join(root, "watch-stopped"), "utf8"),
      "stopped",
    );
  });
});

await test("CLV-085 without the setting the host never fetches and preserves normal exit", async () => {
  await withUpdateRepository(async ({ root, repository, git, old }) => {
    const paths = await programs(root, { daemonMilliseconds: 100 });
    const fetchHead = join(repository, ".git", "FETCH_HEAD");
    await writeFile(fetchHead, "no check\n");
    assert.equal(
      await hostedPrograms({
        ...paths,
        repository,
        runtime: join(root, "host/run"),
        directory: join(root, "host"),
        watchPort: "3663",
        updateMilliseconds: undefined,
      }),
      0,
    );
    assert.equal(await readFile(fetchHead, "utf8"), "no check\n");
    assert.equal(git(["rev-parse", "HEAD"]), old);
    assert.equal(
      await readFile(join(root, "watch-stopped"), "utf8"),
      "stopped",
    );
  });
});
