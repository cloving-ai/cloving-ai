import javascript from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import typescript from "typescript-eslint";
import { structuralRules } from "./quality/structural-rules.ts";
import { rule as cognitiveComplexity } from "eslint-plugin-sonarjs/cjs/S3776/index.js";

export default defineConfig(globalIgnores(["node_modules/**", "dist/**"]), {
  files: ["**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}"],
  extends: [
    javascript.configs.recommended,
    typescript.configs.strictTypeChecked,
  ],
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  linterOptions: {
    noInlineConfig: true,
    reportUnusedDisableDirectives: "error",
  },
  plugins: {
    sonarjs: { rules: { "cognitive-complexity": cognitiveComplexity } },
  },
  rules: {
    ...structuralRules,
    "@typescript-eslint/max-params": "off",
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unsafe-type-assertion": "error",
    "@typescript-eslint/ban-ts-comment": [
      "error",
      {
        "ts-ignore": true,
        "ts-nocheck": true,
        "ts-expect-error": true,
        "ts-check": false,
      },
    ],
    "@typescript-eslint/no-floating-promises": [
      "error",
      { ignoreVoid: false, ignoreIIFE: false, checkThenables: true },
    ],
    "@typescript-eslint/no-misused-promises": [
      "error",
      { checksConditionals: true, checksSpreads: true, checksVoidReturn: true },
    ],
    "@typescript-eslint/switch-exhaustiveness-check": [
      "error",
      { considerDefaultExhaustiveForUnions: false },
    ],
  },
});
