interface BlockGroup {
  readonly count: number;
  readonly dataCodewords: number;
}

interface VersionLayout {
  readonly correctionCodewords: number;
  readonly groups: readonly BlockGroup[];
}

const layouts: readonly VersionLayout[] = [
  { correctionCodewords: 10, groups: [{ count: 1, dataCodewords: 16 }] },
  { correctionCodewords: 16, groups: [{ count: 1, dataCodewords: 28 }] },
  { correctionCodewords: 26, groups: [{ count: 1, dataCodewords: 44 }] },
  { correctionCodewords: 18, groups: [{ count: 2, dataCodewords: 32 }] },
  { correctionCodewords: 24, groups: [{ count: 2, dataCodewords: 43 }] },
  { correctionCodewords: 16, groups: [{ count: 4, dataCodewords: 27 }] },
  { correctionCodewords: 18, groups: [{ count: 4, dataCodewords: 31 }] },
  {
    correctionCodewords: 22,
    groups: [
      { count: 2, dataCodewords: 38 },
      { count: 2, dataCodewords: 39 },
    ],
  },
  {
    correctionCodewords: 22,
    groups: [
      { count: 3, dataCodewords: 36 },
      { count: 2, dataCodewords: 37 },
    ],
  },
  {
    correctionCodewords: 26,
    groups: [
      { count: 4, dataCodewords: 43 },
      { count: 1, dataCodewords: 44 },
    ],
  },
];

function multiply(left: number, right: number): number {
  let product = 0;
  for (let bit = 7; bit >= 0; bit -= 1) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    product ^= ((right >>> bit) & 1) * left;
  }
  return product;
}

function layoutOf(version: number): VersionLayout {
  const layout = layouts[version - 1];
  if (layout === undefined) throw new Error("qr-version-unsupported");
  return layout;
}

function dataCapacity(version: number): number {
  return layoutOf(version).groups.reduce(
    (total, group) => total + group.count * group.dataCodewords,
    0,
  );
}

function countBits(version: number): number {
  return version < 10 ? 8 : 16;
}

export function qrVersion(byteCount: number): number {
  const version = layouts.findIndex(
    (_, index) =>
      4 + countBits(index + 1) + 8 * byteCount <= 8 * dataCapacity(index + 1),
  );
  if (version < 0) throw new Error("qr-text-too-long");
  return version + 1;
}

function bitStream(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const append = (value: number, length: number): void => {
    for (let shift = length - 1; shift >= 0; shift -= 1)
      bits.push((value >>> shift) & 1);
  };
  append(0b0100, 4);
  append(bytes.length, countBits(version));
  for (const byte of bytes) append(byte, 8);
  append(0, Math.min(4, 8 * dataCapacity(version) - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  return bits;
}

export function qrDataCodewords(bytes: Uint8Array, version: number): number[] {
  const bits = bitStream(bytes, version);
  const codewords: number[] = [];
  for (let start = 0; start < bits.length; start += 8)
    codewords.push(
      bits.slice(start, start + 8).reduce((byte, bit) => (byte << 1) | bit, 0),
    );
  for (let index = 0; codewords.length < dataCapacity(version); index += 1)
    codewords.push(index % 2 === 0 ? 0xec : 0x11);
  return codewords;
}

function divisor(degree: number): number[] {
  let coefficients = [...Array.from({ length: degree - 1 }, () => 0), 1];
  let root = 1;
  for (let step = 0; step < degree; step += 1) {
    const previous = coefficients;
    coefficients = previous.map(
      (value, index) => multiply(value, root) ^ (previous[index + 1] ?? 0),
    );
    root = multiply(root, 0x02);
  }
  return coefficients;
}

export function qrCorrection(
  data: readonly number[],
  degree: number,
): number[] {
  const coefficients = divisor(degree);
  let remainder = Array.from({ length: degree }, () => 0);
  for (const codeword of data) {
    const [first, ...rest] = remainder;
    const factor = codeword ^ Number(first);
    remainder = [...rest, 0].map(
      (value, index) => value ^ multiply(Number(coefficients[index]), factor),
    );
  }
  return remainder;
}

function blocks(data: readonly number[], version: number): number[][] {
  const result: number[][] = [];
  let start = 0;
  for (const group of layoutOf(version).groups)
    for (let block = 0; block < group.count; block += 1) {
      result.push(data.slice(start, start + group.dataCodewords));
      start += group.dataCodewords;
    }
  return result;
}

function interleaved(columns: readonly (readonly number[])[]): number[] {
  const longest = Math.max(...columns.map((column) => column.length));
  const result: number[] = [];
  for (let index = 0; index < longest; index += 1)
    for (const column of columns) {
      const value = column[index];
      if (value !== undefined) result.push(value);
    }
  return result;
}

export interface QrCodewords {
  readonly version: number;
  readonly codewords: readonly number[];
}

export function qrCodewords(text: string): QrCodewords {
  const bytes = new TextEncoder().encode(text);
  const version = qrVersion(bytes.length);
  const dataBlocks = blocks(qrDataCodewords(bytes, version), version);
  const degree = layoutOf(version).correctionCodewords;
  return {
    version,
    codewords: [
      ...interleaved(dataBlocks),
      ...interleaved(dataBlocks.map((block) => qrCorrection(block, degree))),
    ],
  };
}
