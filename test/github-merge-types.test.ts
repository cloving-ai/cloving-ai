import assert from "node:assert/strict";
import { test } from "node:test";
import { merge } from "../src/daemon/github-merge.ts";
import type { Operation } from "../src/daemon/github-operation.ts";

await test("CLV-081 exposes concrete success and repair merge results", () => {
  const typedMerge: (
    operation: Operation,
    pull: { readonly number: number; readonly commit: string },
  ) => Promise<
    | {
        readonly number: number;
        readonly commit: string;
        readonly updated: string;
        readonly merged: string;
      }
    | {
        readonly reason: "check-failed" | "merge-conflict";
        readonly output: string;
      }
  > = merge;
  assert.equal(typedMerge, merge);
});
