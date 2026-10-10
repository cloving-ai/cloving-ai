import { Linter } from "eslint";
import sonarjs from "eslint-plugin-sonarjs";
import typescript from "typescript-eslint";
import { structuralRules } from "../../quality/structural-rules.ts";

export function lintFixture(
  source: string,
  filename = "fixture.ts",
): Linter.LintMessage[] {
  const linter = new Linter();
  return linter.verify(
    source,
    {
      files: ["**/*.{ts,js,mjs}"],
      languageOptions: { parser: typescript.parser },
      plugins: { sonarjs, "@typescript-eslint": typescript.plugin },
      rules: structuralRules,
    },
    { filename },
  );
}
