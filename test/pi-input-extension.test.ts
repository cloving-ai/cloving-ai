import assert from "node:assert/strict";
import { test } from "node:test";
import installInput, {
  type PiInputHandler,
} from "../src/daemon/pi-input-extension.ts";

function inputHook(): PiInputHandler {
  const handlers: PiInputHandler[] = [];
  installInput({
    on: (event, handler) => {
      assert.equal(event, "input");
      handlers.push(handler);
    },
  });
  assert.equal(handlers.length, 1);
  const handler = handlers[0];
  assert.ok(handler);
  return handler;
}

await test("CLV-364 the Pi input hook decodes only this invocation's first prompt", () => {
  const input = inputHook();
  const prompt = '\n\t@literal "quotes"\u2028\u2029🐈\n ';
  assert.deepEqual(
    input({ text: JSON.stringify(prompt), source: "interactive" }),
    {
      action: "transform",
      text: prompt,
    },
  );
  assert.equal(
    input({ text: '"follow-up"', source: "interactive" }),
    undefined,
  );
});

await test("CLV-364 the Pi input hook stops malformed or non-string input before model work", () => {
  for (const text of ["truncated", '"unterminated', "null", "42", "{}", "[]"]) {
    const input = inputHook();
    assert.deepEqual(input({ text, source: "interactive" }), {
      action: "handled",
    });
    assert.equal(
      input({ text: '"follow-up"', source: "interactive" }),
      undefined,
    );
  }
});

await test("CLV-364 extension input before the CLI prompt cannot consume its decoder", () => {
  const input = inputHook();
  assert.equal(input({ text: '"background"', source: "extension" }), undefined);
  assert.equal(input({ text: "unrelated", source: "rpc" }), undefined);
  assert.deepEqual(
    input({ text: JSON.stringify("\n@literal\n"), source: "interactive" }),
    {
      action: "transform",
      text: "\n@literal\n",
    },
  );
});
