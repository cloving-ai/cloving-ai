import assert from "node:assert/strict";
import { test } from "node:test";
import { operationDigest } from "../src/broker/operation-digest.ts";

await test("CLV-007 an operation digest is the SHA-256 of the operation identity", () => {
  assert.equal(
    operationDigest(
      '["cloving-operation",0,"run-1","admission","start-run",null,null]',
    ),
    "a53ec9f13731d7d6a8268c194729126810164ce4bb436f7aa93e752a7c030659",
  );
});
