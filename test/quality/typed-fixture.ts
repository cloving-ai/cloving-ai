import { ESLint } from "eslint";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import configuration from "../../eslint.config.mjs";

export async function inspectTypedFixture(
  sources: Readonly<Record<string, string>>,
) {
  const directory = await mkdtemp(join(tmpdir(), "cloving-typed-"));
  try {
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        extends: resolve("tsconfig.json"),
        compilerOptions: { rootDir: directory, types: [], outDir: "./dist" },
        include: ["**/*"],
        exclude: ["dist"],
      }),
    );
    const files = [];
    for (const [name, source] of Object.entries(sources)) {
      const filename = join(directory, name);
      await writeFile(filename, source);
      files.push(filename);
    }
    const parsed = ts.getParsedCommandLineOfConfigFile(
      join(directory, "tsconfig.json"),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(
            ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
          );
        },
      },
    );
    if (!parsed) throw new Error("Fixture compiler configuration is missing");
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const compiler = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
    const linter = new ESLint({
      cwd: directory,
      overrideConfigFile: true,
      overrideConfig: [
        ...configuration,
        { languageOptions: { parserOptions: { tsconfigRootDir: directory } } },
      ],
    });
    const lint = await linter.lintFiles(files);
    return { compiler, lint };
  } finally {
    await rm(directory, { recursive: true });
  }
}
