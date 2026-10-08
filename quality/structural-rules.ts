import type { Linter } from "eslint";

export const structuralRules: Linter.RulesRecord = {
  "@typescript-eslint/max-params": ["error", { max: 5, countVoidThis: false }],
  "max-lines": [
    "error",
    { max: 400, skipBlankLines: false, skipComments: false },
  ],
  "max-lines-per-function": [
    "error",
    { max: 60, skipBlankLines: false, skipComments: false, IIFEs: true },
  ],
  "max-statements": ["error", 40, { ignoreTopLevelFunctions: false }],
  complexity: ["error", { max: 10, variant: "classic" }],
  "sonarjs/cognitive-complexity": ["error", 15],
  "max-depth": ["error", 3],
  "no-else-return": ["error", { allowElseIf: false }],
  "no-lonely-if": "error",
  "no-nested-ternary": "error",
};
