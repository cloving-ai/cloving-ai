import assert from "node:assert/strict";
import { test } from "node:test";
import {
  qrCodewords,
  qrCorrection,
  qrDataCodewords,
  qrVersion,
} from "../src/phone/qr-data.ts";
import { qrMatrix } from "../src/phone/qr-matrix.ts";
import { qrPicture } from "../src/phone/qr-picture.ts";
import reference from "./fixtures/qr-qrcodegen-1.8.0.json" with { type: "json" };

function rows(matrix: readonly (readonly boolean[])[]): readonly string[] {
  return matrix.map((row) => row.map(Number).join(""));
}

for (const code of reference.codes)
  await test(`CLV-188 the QR matrix of version ${String(code.version)} is equal to the ${reference.tool} matrix`, () => {
    const symbol = qrMatrix(code.text);
    assert.equal(symbol.version, code.version);
    assert.equal(symbol.mask, code.mask);
    assert.deepEqual(rows(symbol.modules), code.rows);
  });

function bitsAt(
  modules: readonly (readonly boolean[])[],
  places: readonly (readonly [number, number])[],
): number {
  let value = 0;
  for (const [index, [row, column]] of places.entries())
    if (modules[row]?.[column] === true) value |= 1 << index;
  return value;
}

const firstFormatPlaces: readonly (readonly [number, number])[] = [
  [0, 8],
  [1, 8],
  [2, 8],
  [3, 8],
  [4, 8],
  [5, 8],
  [7, 8],
  [8, 8],
  [8, 7],
  [8, 5],
  [8, 4],
  [8, 3],
  [8, 2],
  [8, 1],
  [8, 0],
];
const secondFormatPlaces: readonly (readonly [number, number])[] = [
  [8, 44],
  [8, 43],
  [8, 42],
  [8, 41],
  [8, 40],
  [8, 39],
  [8, 38],
  [8, 37],
  [38, 8],
  [39, 8],
  [40, 8],
  [41, 8],
  [42, 8],
  [43, 8],
  [44, 8],
];

await test("CLV-188 version 7-M has the standard format bits, version bits and dark module", () => {
  const code = reference.codes.find((item) => item.version === 7);
  assert.ok(code !== undefined);
  const symbol = qrMatrix(code.text);
  const size = symbol.modules.length;
  const formatTable = [
    0b101010000010010, 0b101000100100101, 0b101111001111100, 0b101101101001011,
    0b100010111111001, 0b100000011001110, 0b100111110010111, 0b100101010100000,
  ];
  assert.equal(size, 45);
  assert.equal(
    bitsAt(symbol.modules, firstFormatPlaces),
    formatTable[symbol.mask],
  );
  assert.equal(
    bitsAt(symbol.modules, secondFormatPlaces),
    formatTable[symbol.mask],
  );
  const versionPlaces = Array.from(
    { length: 18 },
    (_, index): [number, number] => [
      Math.floor(index / 3),
      size - 11 + (index % 3),
    ],
  );
  assert.equal(bitsAt(symbol.modules, versionPlaces), 0x07c94);
  assert.equal(
    bitsAt(
      symbol.modules,
      versionPlaces.map(([row, column]): [number, number] => [column, row]),
    ),
    0x07c94,
  );
  assert.equal(symbol.modules[size - 8]?.[8], true);
});

await test("CLV-188 the error correction blocks of version 7-M", () => {
  const code = reference.codes.find((item) => item.version === 7);
  assert.ok(code !== undefined);
  const { version, codewords } = qrCodewords(code.text);
  assert.equal(version, 7);
  assert.equal(codewords.length, 196);
  const blocks = [0, 1, 2, 3].map((block) =>
    Array.from(
      { length: 31 },
      (_, index) => codewords[index * 4 + block] ?? -1,
    ),
  );
  const corrections = [0, 1, 2, 3].map((block) =>
    Array.from(
      { length: 18 },
      (_, index) => codewords[124 + index * 4 + block] ?? -1,
    ),
  );
  assert.deepEqual(
    blocks.flat(),
    qrDataCodewords(new TextEncoder().encode(code.text), 7),
  );
  blocks.forEach((block, index) => {
    assert.deepEqual(qrCorrection(block, 18), corrections[index]);
  });
  assert.deepEqual(
    qrCorrection(
      [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17],
      10,
    ),
    [196, 35, 39, 119, 235, 215, 231, 226, 93, 23],
  );
});

await test("CLV-188 the encoder refuses a text longer than version 10-M holds", () => {
  assert.equal(qrVersion(213), 10);
  assert.throws(() => qrVersion(214), /qr-text-too-long/);
  assert.throws(
    () => qrDataCodewords(new Uint8Array(), 11),
    /qr-version-unsupported/,
  );
});

await test("CLV-188 the QR picture has a quiet zone of 4 modules and joins dark runs", () => {
  const picture = qrPicture([
    [true, true, false],
    [false, true, false],
    [false, false, false],
  ]);
  assert.deepEqual(picture, {
    size: 11,
    path: "M4 4h2v1h-2zM5 5h1v1h-1z",
  });
});
