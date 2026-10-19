import type ts from "typescript";
import { sourceEffectNodes } from "../tools/workflow-source-effects.ts";

export {
  referenceSymbol,
  type ReferenceContext,
} from "../tools/workflow-source-effects.ts";

export interface EffectFinding {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
}

export function inspectEffects(
  program: ts.Program,
  files: readonly string[],
): EffectFinding[] {
  const checker = program.getTypeChecker();
  const findings: EffectFinding[] = [];
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`missing-effect-source: ${file}`);
    if (source.isDeclarationFile) continue;
    for (const node of sourceEffectNodes(source, { checker })) {
      findings.push({
        rule: "restricted-effect",
        file,
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
    }
  }
  return findings;
}
