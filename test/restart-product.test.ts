import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { withFiles } from "./quality/files-fixture.ts";
import { productCopy } from "./restart-product-fixture.ts";
import { field, items } from "./self-host-fixture.ts";

async function coveredScripts(directory: string): Promise<readonly string[]> {
  const scripts: string[] = [];
  for (const name of await readdir(directory)) {
    const report: unknown = JSON.parse(
      await readFile(join(directory, name), "utf8"),
    );
    scripts.push(
      ...items(field(report, "result")).map((entry) =>
        String(field(entry, "url")),
      ),
    );
  }
  return scripts;
}

await test(
  "CLV-347 fresh product setup excludes compiler coverage and retains public CLI coverage",
  { timeout: 120_000 },
  () =>
    withFiles({}, async (root) => {
      const coverage = join(root, "coverage");
      const probe = join(root, "probe.mjs");
      await mkdir(coverage);
      await writeFile(
        probe,
        `import { writeFileSync } from "node:fs";
const compiler = process.argv[1].endsWith("/typescript/bin/tsc");
writeFileSync(new URL(compiler ? "compiler.json" : "runtime.json", import.meta.url), JSON.stringify({ coverage: process.env.NODE_V8_COVERAGE ?? null, compileCache: process.env.NODE_DISABLE_COMPILE_CACHE ?? null }));`,
      );
      const environment = { ...process.env };
      process.env["NODE_V8_COVERAGE"] = coverage;
      process.env["NODE_DISABLE_COMPILE_CACHE"] = "1";
      process.env["NODE_OPTIONS"] = `--import=${pathToFileURL(probe).href}`;
      try {
        const started = performance.now();
        const product = await productCopy(root);
        console.info(
          "Product setup milliseconds:",
          performance.now() - started,
        );
        const compiler: unknown = JSON.parse(
          await readFile(join(root, "compiler.json"), "utf8"),
        );
        assert.equal(field(compiler, "coverage"), null);
        assert.equal(field(compiler, "compileCache"), "1");
        assert.equal(process.env["NODE_V8_COVERAGE"], coverage);
        const executable = join(product, "dist/src/cli.js");
        execFileSync(process.execPath, [executable, "--version"], {
          cwd: product,
          timeout: 10_000,
        });
        const runtime: unknown = JSON.parse(
          await readFile(join(root, "runtime.json"), "utf8"),
        );
        assert.equal(field(runtime, "coverage"), coverage);
        const scripts = await coveredScripts(coverage);
        assert.ok(scripts.includes(pathToFileURL(executable).href));
        assert.equal(
          scripts.some((url) => url.includes("/typescript/lib/_tsc.js")),
          false,
        );
      } finally {
        process.env = environment;
      }
    }),
);
