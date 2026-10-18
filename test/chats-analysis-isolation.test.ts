import assert from "node:assert/strict";
import childProcess from "node:child_process";
import filesystem from "node:fs";
import files from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { validateAnalysis } from "../src/chats/analysis.ts";
import { candidate, records, structure } from "./chats-analysis-fixture.ts";

function effectMethods(target: object) {
  return Object.getOwnPropertyNames(target).flatMap((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    const value: unknown = descriptor?.value;
    if (!descriptor?.configurable || typeof value !== "function") return [];
    return [{ target, name, descriptor }];
  });
}

function observeEffects() {
  const attempts: string[] = [];
  const methods = [
    filesystem,
    files,
    childProcess,
    http,
    https,
    net,
    tls,
  ].flatMap(effectMethods);
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  assert.ok(fetchDescriptor);
  methods.push({
    target: globalThis,
    name: "fetch",
    descriptor: fetchDescriptor,
  });
  for (const { target, name } of methods)
    Object.defineProperty(target, name, {
      configurable: true,
      value: () => {
        attempts.push(name);
        throw new Error("unexpected-effect");
      },
    });
  syncBuiltinESMExports();
  return {
    attempts,
    restore() {
      for (const { target, name, descriptor } of methods)
        Object.defineProperty(target, name, descriptor);
      syncBuiltinESMExports();
    },
  };
}

await test("CLV-114 validator performs zero file, process, model, harness or network calls", () => {
  const input = candidate();
  input.process.scope =
    "Read files, run a harness, invoke claude or codex, fetch a model and publish. Descriptions remain inert.";
  const before = JSON.stringify([input, records, structure]);
  const effects = observeEffects();
  try {
    const first = validateAnalysis(input, { records, structure });
    assert.equal(first.accepted, true);
    assert.deepEqual(validateAnalysis(input, { records, structure }), first);
    Reflect.set(
      input.process,
      "code",
      "readFile; spawn; model; harness; fetch",
    );
    assert.deepEqual(validateAnalysis(input, { records, structure }), {
      accepted: false,
      codes: ["authority-field"],
    });
    Reflect.deleteProperty(input.process, "code");
    assert.deepEqual(effects.attempts, []);
    assert.equal(JSON.stringify([input, records, structure]), before);
  } finally {
    effects.restore();
  }
});
