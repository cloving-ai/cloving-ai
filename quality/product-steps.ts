import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

const definition =
  /export\s+async\s+function\s+(\w+)\s*\([^)]*\)[^{]*\{\s*["']use step["']/g;
const directive = /["']use (?:step|workflow)["']/g;
const conditions = ["workflow", "default", "require", "import", "node"];

interface ProductStep {
  readonly file: string;
  readonly subpath: string;
  readonly names: readonly string[];
}

async function productSteps(candidate: string): Promise<{
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly steps: readonly ProductStep[];
}> {
  const metadata = fields(
    JSON.parse(await readFile(join(candidate, "package.json"), "utf8")),
  );
  const steps: ProductStep[] = [];
  for (const entry of await readdir(join(candidate, "src"), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const source = await readFile(file, "utf8");
    const names = [...source.matchAll(definition)].map((match) =>
      String(match[1]),
    );
    const total = source.match(directive)?.length ?? 0;
    if (total === 0) continue;
    const path = relative(join(candidate, "src"), file);
    const parts = path.split(sep);
    if (names.length !== total || parts.length !== 2 || parts[0] !== "steps")
      throw new Error(`unqualified-product-durable: ${path}`);
    const subpath = exportSubpath(
      metadata["exports"],
      `./dist/src/steps/${basename(path, ".ts")}.js`,
    );
    steps.push({ file, subpath, names });
  }
  return { metadata, steps };
}

export async function productStepIdentities(
  candidate: string,
): Promise<string[]> {
  const { metadata, steps } = await productSteps(candidate);
  return steps.flatMap((step) =>
    step.names.map(
      (name) =>
        `step//${String(metadata["name"])}${step.subpath}@${String(metadata["version"])}//${name}`,
    ),
  );
}

export async function productStepExports(
  candidate: string,
): Promise<Readonly<Record<string, readonly string[]>>> {
  const { steps } = await productSteps(candidate);
  return Object.fromEntries(
    steps
      .map((step): [string, readonly string[]] => [step.file, step.names])
      .sort(([first], [second]) => (first < second ? -1 : 1)),
  );
}

function exportSubpath(exports: unknown, target: string): string {
  for (const [subpath, value] of Object.entries(fields(exports))) {
    const resolved = conditions
      .map((condition) => fields(value)[condition])
      .find((item) => typeof item === "string");
    if (resolved === target && subpath.startsWith("./"))
      return subpath.slice(1);
  }
  throw new Error(`unexported-product-step: ${target}`);
}

function fields(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}
