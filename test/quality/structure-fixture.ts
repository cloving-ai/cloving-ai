import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { fixtureProgram } from "./compiler-host-fixture.ts";
import {
  inspectStructure,
  type StructureFinding,
} from "../../quality/structure.ts";

export async function inspectFixture(
  sources: Readonly<Record<string, string>>,
): Promise<StructureFinding[]> {
  const directory = await mkdtemp(join(tmpdir(), "cloving-structure-"));
  try {
    const files = [];
    for (const [name, source] of Object.entries(sources)) {
      const filename = join(directory, name);
      await writeFile(filename, source);
      files.push(filename);
    }
    const options: ts.CompilerOptions = {
      strict: true,
      target: ts.ScriptTarget.ESNext,
    };
    const program = fixtureProgram(files, options);
    if (program.getSyntacticDiagnostics().length > 0)
      throw new Error("Invalid structure fixture syntax");
    return inspectStructure(program);
  } finally {
    await rm(directory, { recursive: true });
  }
}
