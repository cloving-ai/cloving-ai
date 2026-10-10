import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ESLint } from "eslint";
import type { StructureFinding } from "../../quality/structure.ts";
import { lintFixture } from "./lint-fixture.ts";
import { inspectFixture } from "./structure-fixture.ts";

const three = "turn: string, request: string, epoch: number";
const two = "turn: string, request: string";
const options =
  "turn: string, options: { readonly request: string; readonly epoch: number }";

function forms(parameters: string): Readonly<Record<string, string>> {
  return {
    "function declaration": `function plan(${parameters}) {}`,
    "function expression": `const plan = function (${parameters}) {};`,
    "arrow function": `const plan = (${parameters}) => {};`,
    method: `class Planner { plan(${parameters}) {} }`,
    constructor: `class Planner { constructor(${parameters}) {} }`,
    callback: `register((${parameters}) => {});`,
    "function type": `type Plan = (${parameters}) => void;`,
    "declared function": `declare function plan(${parameters}): void;`,
  };
}

function rules(source: string, filename?: string): readonly unknown[] {
  return lintFixture(source, filename).map((finding) => finding.ruleId);
}

for (const [form, source] of Object.entries(forms(three)))
  await test(`CLV-044 three positional parameters are rejected: ${form}`, () => {
    assert.deepEqual(rules(source), ["max-params"]);
  });

for (const [form, source] of Object.entries(forms(two)))
  await test(`CLV-044 two positional parameters are accepted: ${form}`, () => {
    assert.deepEqual(rules(source), []);
  });

for (const [form, source] of Object.entries(forms(options)))
  await test(`CLV-044 one subject and one options object are accepted: ${form}`, () => {
    assert.deepEqual(rules(source), []);
  });

for (const context of ["this: void", "this: { value: number }"]) {
  await test(`CLV-044 a '${context}' parameter does not count toward the limit of two`, () => {
    assert.deepEqual(rules(`function plan(${context}, ${two}) {}`), []);
  });
  await test(`CLV-044 a '${context}' parameter does not hide a third positional parameter`, () => {
    assert.deepEqual(rules(`function plan(${context}, ${three}) {}`), [
      "max-params",
    ]);
  });
}

const repository = resolve(import.meta.dirname, "../..");

for (const filename of [
  "src/example.ts",
  "test/example.test.ts",
  "tools/example.ts",
  "quality/example.ts",
  "eslint.config.mjs",
])
  await test(`CLV-044 the repository lint configuration applies the limit of two positional parameters to ${filename}`, async () => {
    const linter = new ESLint({ cwd: repository });
    const configuration: unknown = await linter.calculateConfigForFile(
      join(repository, filename),
    );
    const applied: unknown = Reflect.get(Object(configuration), "rules");
    assert.deepEqual(Reflect.get(Object(applied), "max-params"), [
      2,
      { max: 2, countThis: "never" },
    ]);
  });

const tuple = "[string, string, number]";

function positional(findings: readonly StructureFinding[]): readonly unknown[] {
  return findings
    .filter((finding) => finding.rule === "max-positional-parameters")
    .map((finding) => finding.measured);
}

const bypasses: Readonly<Record<string, string>> = {
  "rest tuple in a function declaration": `export function plan(...parameters: ${tuple}) { return parameters.length; }`,
  "destructured rest tuple": `export function plan(...[turn, request, epoch]: ${tuple}) { return turn + request + String(epoch); }`,
  "rest tuple in a function expression": `export const plan = function (...parameters: ${tuple}) { return parameters.length; };`,
  "rest tuple in an arrow function": `export const plan = (...parameters: ${tuple}) => parameters.length;`,
  "rest tuple in a method": `export class Planner { plan(...parameters: ${tuple}) { return parameters.length; } }`,
  "rest tuple in a constructor": `export class Planner { readonly size: number; constructor(...parameters: ${tuple}) { this.size = parameters.length; } }`,
  "rest tuple in a callback": `declare function register(callback: unknown): void; register((...parameters: ${tuple}) => parameters.length);`,
  "rest tuple after one parameter":
    "export function plan(turn: string, ...rest: [string, number]) { return turn + String(rest.length); }",
  "rest tuple with a variable element":
    "export function plan(...parameters: [string, string, ...number[]]) { return parameters.length; }",
  "rest tuple behind a type parameter": `export function plan<Parameters extends ${tuple}>(...parameters: Parameters) { return parameters.length; }`,
  "rest tuple in a union": `export function plan(...parameters: [string] | ${tuple}) { return parameters.length; }`,
  "interface method signature":
    "export interface Planner { plan(turn: string, request: string, epoch: number): void }",
  "call signature":
    "export interface Plan { (turn: string, request: string, epoch: number): void }",
  "construct signature":
    "export interface PlannerClass { new (turn: string, request: string, epoch: number): object }",
  "constructor type":
    "export type PlannerClass = new (turn: string, request: string, epoch: number) => object;",
  "abstract method":
    "export abstract class Planner { abstract plan(turn: string, request: string, epoch: number): void; }",
  "overload signature":
    "export function plan(turn: string, request: string, epoch: number): void; export function plan(turn: string, options: object): void; export function plan(turn: string, options: object | string): void { void turn; void options; }",
  "rest list with three names in a binding pattern":
    "export function plan(...[turn, request, epoch]: readonly (string | number)[]) { return [turn, request, epoch].join(':'); }",
  "rest list with an object binding pattern":
    "export function plan(...{ 0: turn, 1: request, 2: epoch }: readonly (string | number)[]) { return [turn, request, epoch].join(':'); }",
  "rest list with a nested rest binding pattern":
    "export function plan(...[turn, ...[request, epoch]]: readonly (string | number)[]) { return [turn, request, epoch].join(':'); }",
  "two parameters and a rest list":
    "export function plan(turn: string, request: string, ...values: number[]) { return turn + request + String(values.length); }",
  "rest tuple behind two type parameters": `export function plan<First extends ${tuple}, Second extends First>(...parameters: Second) { return parameters.length; }`,
  "type parameter with a union constraint": `export function plan<Values extends [string] | ${tuple}>(...parameters: Values) { return parameters.length; }`,
  "type parameter in a union": `export function plan<Values extends ${tuple}>(...parameters: Values | []) { return parameters.length; }`,
  "rest list with holes in a binding pattern":
    "export function plan(...[, , epoch]: readonly (string | number)[]) { return String(epoch); }",
  "infer pattern with a tuple constraint": `export type Call<Callback> = Callback extends (...parameters: infer Values extends ${tuple}) => unknown ? Values : never;`,
};

for (const [form, source] of Object.entries(bypasses))
  await test(`CLV-044 the structure check rejects three positional inputs: ${form}`, async () => {
    const findings = positional(await inspectFixture({ "fixture.ts": source }));
    assert.equal(findings.length > 0, true);
    assert.equal(
      findings.every((measured) => measured === 3),
      true,
    );
  });

const triple = "[string, string, number]";

const unresolved: Readonly<Record<string, string>> = {
  "tuple in an intersection with a list": `export function plan(...parameters: ${triple} & readonly unknown[]) { return parameters.length; }`,
  "tuple in an intersection with an object": `export function plan(...parameters: ${triple} & { readonly kind?: "plan" }) { return parameters.length; }`,
  "type parameter with an intersection constraint": `export function plan<Values extends ${triple} & readonly unknown[]>(...parameters: Values) { return parameters.length; }`,
  "union of tuples in an intersection": `export function plan(...parameters: ([string] | ${triple}) & readonly unknown[]) { return parameters.length; }`,
  "list with fixed index properties":
    "export function plan(...parameters: readonly (string | number)[] & { readonly 0: string; readonly 1: string; readonly 2: number; readonly length: 3 }) { return parameters.length; }",
  "mapped type over a tuple": `export function plan(...parameters: { readonly [Position in keyof ${triple}]: ${triple}[Position] }) { return parameters.length; }`,
  "mapped type in a tuple spread": `export function plan<Values extends readonly ${triple}>(...parameters: [...{ readonly [Position in keyof Values]: Values[Position] }]) { return parameters.length; }`,
  "conditional type in a tuple spread": `export function plan<Turn extends string>(...parameters: [...(Turn extends string ? [Turn, string, number] : never)]) { return parameters.length; }`,
  "indexed access type in a tuple spread": `interface Shapes { readonly plan: ${triple} } export function plan<Key extends keyof Shapes>(...parameters: [...Shapes[Key]]) { return parameters.length; }`,
  "type parameter with an intersection constraint in a tuple spread": `export function plan<Values extends ${triple} & readonly unknown[]>(...parameters: [...Values]) { return parameters.length; }`,
  "interface method with a mapped type in a tuple spread": `export interface Planner { plan<Values extends readonly ${triple}>(...parameters: [...{ readonly [Position in keyof Values]: Values[Position] }]): void }`,
  "one parameter and a mapped type in a tuple spread":
    "export function plan<Values extends readonly [number, number]>(turn: string, ...parameters: [...{ readonly [Position in keyof Values]: Values[Position] }]) { return turn + String(parameters.length); }",
  "conditional type inside a distributive conditional type":
    "export function plan<Turn extends string>(turn: Turn, ...parameters: Turn extends string ? (string extends Turn ? [] : [string, number]) : never) { return turn + String(parameters.length); }",
  "type parameter with a nested conditional constraint":
    "type Shape<Turn extends string> = Turn extends string ? (string extends Turn ? readonly [] : readonly [string, number]) : never; export function plan<Turn extends string, Values extends Shape<Turn>>(turn: Turn, ...parameters: Values) { return turn + String(parameters.length); }",
  "method bound by a this type in a subclass": `export abstract class Base { abstract readonly shape: readonly unknown[]; plan(...parameters: this["shape"]) { return parameters.length; } } export class Planner extends Base { readonly shape: ${triple} = ["", "", 0]; }`,
  "typed listener with an indexed access rest":
    "interface Events { readonly turn: [name: string]; readonly stop: [] } export function on<Name extends keyof Events>(name: Name, listener: (...values: Events[Name]) => void) { return [name, listener]; }",
  "conditional rest of one":
    "export function send<Mode extends 'ping' | 'text'>(mode: Mode, ...extra: Mode extends 'text' ? [body: string] : []) { return mode + String(extra.length); }",
  "generic forward with the parameters of a callback type":
    "export function forward<Callback extends (...values: never[]) => unknown>(callback: Callback, ...parameters: Parameters<Callback>) { return callback(...parameters); }",
  "rest tuple with a generic tail":
    "export function plan<Rest extends readonly unknown[]>(...parameters: [turn: string, ...rest: Rest]) { return parameters.length; }",
  "arrow function with a tuple intersection": `export const plan = (...parameters: ${triple} & readonly unknown[]) => parameters.length;`,
  "interface method with a tuple intersection": `export interface Planner { plan(...parameters: ${triple} & readonly unknown[]): void }`,
  "this type as the rest type in a list subclass":
    "export class Values extends Array<string> { plan(...parameters: this) { return parameters.length; } }",
};

for (const [form, source] of Object.entries(unresolved))
  await test(`CLV-044 the structure check rejects a rest parameter that is not a list or a tuple of fixed elements: ${form}`, async () => {
    assert.deepEqual(
      positional(await inspectFixture({ "fixture.ts": source })),
      ["unbounded"],
    );
  });

const matched = `${triple} extends [...infer Values]`;

const inferred: Readonly<Record<string, string>> = {
  "function type": `export type Plan = ${matched} ? (...parameters: Values) => string : never;`,
  "generic function type": `export type Plan = ${matched} ? <Given extends Values>(...parameters: Given) => Given : never;`,
  "constructor type": `export type PlannerClass = ${matched} ? new (...parameters: Values) => object : never;`,
  "method signature": `export type Planner = ${matched} ? { plan(...parameters: Values): void } : never;`,
  "arrow function with the generic function type": `type Plan = ${matched} ? <Given extends Values>(...parameters: Given) => number : never; export const plan: Plan = (...parameters) => parameters.length;`,
  "one parameter before the rest parameter":
    "export type Plan = [string, number] extends [...infer Values] ? (turn: string, ...parameters: Values) => string : never;",
  "declared list constraint": `export type Plan = ${triple} extends infer Values extends readonly unknown[] ? (...parameters: Values) => string : never;`,
  "parameters of a library function":
    "export type Plan = typeof Reflect.set extends (...parameters: infer Values) => unknown ? (...parameters: Values) => string : never;",
  "implied tuple constraint": `interface Wrap<Values extends ${triple}> { readonly values: Values } export type Call<Shape> = Shape extends Wrap<infer Values> ? (...parameters: Values) => Shape : never;`,
  "promisified callback type":
    "export type Promisified<Callback> = Callback extends (...parameters: infer Values) => infer Result ? (...parameters: Values) => Promise<Result> : never;",
};

for (const [form, source] of Object.entries(inferred))
  await test(`CLV-044 the structure check rejects an infer type parameter as a rest type outside its pattern: ${form}`, async () => {
    const findings = positional(await inspectFixture({ "fixture.ts": source }));
    assert.equal(findings.length > 0, true);
    assert.equal(
      findings.every((measured) => measured === "unbounded"),
      true,
    );
  });

const permitted: Readonly<Record<string, string>> = {
  "rest list":
    "export function join(...values: string[]) { return values.join(':'); }",
  "one parameter and a rest list":
    "export function join(separator: string, ...values: string[]) { return values.join(separator); }",
  "rest tuple of two":
    "export function plan(...parameters: [string, string]) { return parameters.length; }",
  "this parameter before two parameters":
    "export function plan(this: { readonly prefix: string }, turn: string, request: string) { return this.prefix + turn + request; }",
  "interface method with one options object":
    "export interface Planner { plan(turn: string, options: { readonly request: string; readonly epoch: number }): void }",
  "index signature":
    "export interface Values { readonly [name: string]: number }",
  "generic wrapper with a rest list":
    "export function wrap<Values extends readonly unknown[], Result>(callback: (...parameters: Values) => Result) { return callback; }",
  "error subclass with the constructor parameters of Error":
    "export class Failure extends Error { constructor(...parameters: ConstructorParameters<typeof Error>) { super(...parameters); } }",
  "rest tuple with one optional element":
    "export function plan(...parameters: [turn: string, options?: object]) { return parameters.length; }",
  "rest tuple with a leading list":
    "export function plan(...parameters: [...parts: string[], options: object]) { return parameters.length; }",
  "two parameters and an empty rest tuple":
    "export function plan(turn: string, request: string, ...rest: []) { return turn + request + String(rest.length); }",
  "one parameter and a generic rest list":
    "export function call<Values extends readonly unknown[]>(name: string, ...values: Values) { return name + String(values.length); }",
  "tuple inference hint":
    "export function tuple<Values extends readonly unknown[] | []>(...values: Values) { return values; }",
  "parameters of a function with two parameters":
    "declare function pair(turn: string, epoch: number): string; export function logged(...parameters: Parameters<typeof pair>) { return pair(...parameters); }",
  "infer pattern for a rest list":
    "export type Third<Callback> = Callback extends (...parameters: infer Values) => unknown ? Values[2] : never;",
  "replace callback with a rest list":
    "export const replaced = 'a'.replace(/a/u, (match, ...groups: unknown[]) => match + String(groups.length));",
  "infer pattern with a declared list constraint":
    "export type Rest<Callback> = Callback extends (...parameters: infer Values extends readonly unknown[]) => unknown ? Values : never;",
  "promisified callback with list type parameters":
    "export function later<Values extends readonly unknown[], Result>(callback: (...parameters: Values) => Result) { return (...parameters: Values) => Promise.resolve(callback(...parameters)); }",
};

for (const [form, source] of Object.entries(permitted))
  await test(`CLV-044 the structure check accepts: ${form}`, async () => {
    assert.deepEqual(
      positional(await inspectFixture({ "fixture.ts": source })),
      [],
    );
  });
