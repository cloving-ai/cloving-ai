import assert from "node:assert/strict";
import { record, type Fields } from "../src/protocol.ts";

export interface ReplyRead {
  readonly number: (key: string) => number;
  readonly text: (key: string) => string;
  readonly flag: (key: string) => boolean;
  readonly textOrNull: (key: string) => string | null;
  readonly texts: (key: string) => readonly string[];
  readonly part: (key: string) => ReplyRead;
}

export function replyReader(name: string, values: Fields): ReplyRead {
  const failed = (key: string, kind: string): string =>
    `${name}: ${key} is not ${kind}: ${JSON.stringify(values)}`;
  return {
    number: (key) => {
      const value = values[key];
      assert.ok(typeof value === "number", failed(key, "a number"));
      return value;
    },
    text: (key) => {
      const value = values[key];
      assert.ok(typeof value === "string", failed(key, "a text"));
      return value;
    },
    flag: (key) => {
      const value = values[key];
      assert.ok(typeof value === "boolean", failed(key, "a flag"));
      return value;
    },
    textOrNull: (key) => {
      const value = values[key];
      assert.ok(
        value === null || typeof value === "string",
        failed(key, "a text or null"),
      );
      return value;
    },
    texts: (key) => {
      const value = values[key];
      const texts = Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
      assert.ok(
        Array.isArray(value) && texts.length === value.length,
        failed(key, "a text list"),
      );
      return texts;
    },
    part: (key) => {
      const value = record(values[key]);
      assert.ok(value !== undefined, failed(key, "a record"));
      return replyReader(`${name}.${key}`, value);
    },
  };
}
