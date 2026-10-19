import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkflowCandidate } from "../src/workflow-candidate.ts";
import { analyzeWorkflowCandidate } from "../tools/workflow-candidate-source.ts";
import {
  candidateDeclaration,
  candidateSource,
} from "./workflow-candidate-fixtures.ts";

const sources = {
  process: [
    "process.cwd();",
    "const host = process; host.exit(0);",
    "const { exit: stop } = process; stop(0);",
    "const holder = { process }; holder.process.exit(0);",
    "globalThis.process.exit(0);",
    'globalThis["process"].exit(0);',
    'console.log("effect");',
  ],
  file: [
    "new FileReader();",
    "const Reader = FileReader; new Reader();",
    "const { FileReader: Reader } = globalThis; new Reader();",
    'process.getBuiltinModule("fs").readFileSync("synthetic");',
  ],
  network: [
    'await fetch("https://example.invalid");',
    'const send = fetch; await send("https://example.invalid");',
    'const { fetch: send } = globalThis; await send("https://example.invalid");',
    'await globalThis["fetch"]("https://example.invalid");',
    'new WebSocket("wss://example.invalid");',
  ],
  "waiting-timer": [
    "setTimeout(() => 1, 10);",
    "const wait = setInterval; wait(() => 1, 10);",
    "const { setImmediate: wait } = global; wait(() => 1);",
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
    "const { wait } = Atomics; wait();",
  ],
  environment: [
    "process.env;",
    "const { env } = process; return env;",
    "navigator.userAgent;",
    "Deno.env.get('synthetic');",
    "const environment = globalThis; return environment.process.env;",
  ],
  "dynamic-evaluation": [
    'eval("1");',
    'const evaluate = eval; evaluate("1");',
    'const { Function: evaluate } = globalThis; evaluate("return 1")();',
    'Function("return 1")();',
    '(() => 1).constructor("return 1")();',
    'const { constructor: evaluate } = () => 1; evaluate("return 1")();',
    '([])["constructor"]["constructor"]("return 1")();',
    'Object.getPrototypeOf(() => 1).constructor("return 1")();',
    'Reflect.get(() => 1, "constructor")("return 1")();',
    "const prototype = ({}).__proto__;",
    'const { constructor } = () => 1; constructor("return 1")();',
    "new WebAssembly.Module(new Uint8Array());",
  ],
};

for (const [category, examples] of Object.entries(sources)) {
  for (const [index, example] of examples.entries()) {
    await test(`CLV-121 direct ${category} source ${String(index)} is refused including in unused functions`, () => {
      for (const source of [
        candidateSource(example),
        `${candidateSource("return 1;")}\nfunction unused() { ${example} }`,
        `${example}\n${candidateSource("return 1;")}`,
      ])
        assert.deepEqual(
          checkWorkflowCandidate({
            declaration: candidateDeclaration,
            ...analyzeWorkflowCandidate(source),
          }),
          ["direct-effect"],
        );
    });
  }
}

await test("CLV-121 local symbols shadowing restricted globals remain pure", () => {
  for (const name of [
    "process",
    "fetch",
    "FileReader",
    "setTimeout",
    "navigator",
    "eval",
    "Function",
    "globalThis",
    "require",
  ])
    assert.deepEqual(
      checkWorkflowCandidate({
        declaration: candidateDeclaration,
        ...analyzeWorkflowCandidate(
          `${candidateSource("return 1;")}\nfunction pure(${name}: () => number) { return ${name}(); }`,
        ),
      }),
      [],
      name,
    );
});

await test("CLV-121 type-only declarations cannot shadow a restricted runtime global", () => {
  for (const declaration of [
    "type process = unknown;",
    'import type { ProtectedRequest as process } from "cloving/workflows";',
  ])
    assert.deepEqual(
      checkWorkflowCandidate({
        declaration: candidateDeclaration,
        ...analyzeWorkflowCandidate(
          `${declaration}\n${candidateSource("process.exit(0);")}`,
        ),
      }),
      ["direct-effect"],
    );
});

for (const body of [
  "AbortSignal.timeout(1000);",
  "const timer = AbortSignal.timeout; timer(1000);",
  "clearTimeout(1); clearInterval(1); clearImmediate(1);",
  "queueMicrotask(() => 1);",
  "document.cookie;",
  'new BroadcastChannel("candidate").postMessage("effect");',
  "Date.now();",
  "const clock = performance; clock.now();",
  "crypto.randomUUID();",
  "Math.random();",
  "Math.valueOf().random();",
  "const math = Math.valueOf(); math.random();",
  "const { random } = Math.valueOf(); random();",
  "const valueOf = Math.valueOf; valueOf.call(Math).random();",
  "Math.toString();",
  "Math.unknownMember();",
  "const math = Math; math.random();",
  "const { random } = Math; random();",
]) {
  await test(`CLV-121 shared ambient policy refuses ${body}`, () => {
    assert.deepEqual(
      checkWorkflowCandidate({
        declaration: candidateDeclaration,
        ...analyzeWorkflowCandidate(candidateSource(body)),
      }),
      ["direct-effect"],
    );
  });
}

await test("CLV-121 known pure Math members and shadowed Math values pass", () => {
  for (const body of [
    "return Math.max(1, Math.PI);",
    "const absolute = Math.abs; return absolute(-1);",
    "return Math.hypot(3, 4);",
    "const Math = { valueOf: () => ({ random: () => 1 }) }; return Math.valueOf().random();",
  ])
    assert.deepEqual(
      checkWorkflowCandidate({
        declaration: candidateDeclaration,
        ...analyzeWorkflowCandidate(candidateSource(body)),
      }),
      [],
      body,
    );
});
