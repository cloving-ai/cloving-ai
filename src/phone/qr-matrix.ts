import { qrCodewords } from "./qr-data.ts";
import { qrPenalty } from "./qr-penalty.ts";

export interface QrSymbol {
  readonly version: number;
  readonly mask: number;
  readonly modules: readonly (readonly boolean[])[];
}

interface Canvas {
  readonly size: number;
  readonly modules: boolean[][];
  readonly reserved: boolean[][];
}

const alignmentCenters: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const masks: readonly ((row: number, column: number) => boolean)[] = [
  (row, column) => (row + column) % 2 === 0,
  (row) => row % 2 === 0,
  (_, column) => column % 3 === 0,
  (row, column) => (row + column) % 3 === 0,
  (row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
  (row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
  (row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
  (row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0,
];

function grid(size: number): boolean[][] {
  return Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false),
  );
}

function mark(canvas: Canvas, place: readonly [number, number, boolean]): void {
  const [row, column, dark] = place;
  const modules = canvas.modules[row];
  const reserved = canvas.reserved[row];
  if (modules === undefined || reserved === undefined) return;
  if (column < 0 || column >= canvas.size) return;
  modules[column] = dark;
  reserved[column] = true;
}

function finder(canvas: Canvas, corner: readonly [number, number]): void {
  const [top, left] = corner;
  for (let row = -1; row <= 7; row += 1)
    for (let column = -1; column <= 7; column += 1) {
      const distance = Math.max(Math.abs(row - 3), Math.abs(column - 3));
      mark(canvas, [top + row, left + column, distance !== 2 && distance < 4]);
    }
}

function alignment(canvas: Canvas, center: readonly [number, number]): void {
  const [top, left] = center;
  for (let row = -2; row <= 2; row += 1)
    for (let column = -2; column <= 2; column += 1)
      mark(canvas, [
        top + row,
        left + column,
        Math.max(Math.abs(row), Math.abs(column)) !== 1,
      ]);
}

function functionPatterns(canvas: Canvas, version: number): void {
  const last = canvas.size - 7;
  for (let index = 8; index < canvas.size - 8; index += 1) {
    mark(canvas, [6, index, index % 2 === 0]);
    mark(canvas, [index, 6, index % 2 === 0]);
  }
  finder(canvas, [0, 0]);
  finder(canvas, [0, last]);
  finder(canvas, [last, 0]);
  const centers = alignmentCenters[version - 1] ?? [];
  const final = centers.length - 1;
  centers.forEach((row, rowIndex) => {
    centers.forEach((column, columnIndex) => {
      const corner =
        (rowIndex === 0 && (columnIndex === 0 || columnIndex === final)) ||
        (rowIndex === final && columnIndex === 0);
      if (!corner) alignment(canvas, [row, column]);
    });
  });
}

function formatPlaces(size: number): readonly (readonly [number, number])[] {
  const first: [number, number][] = [
    ...[0, 1, 2, 3, 4, 5, 7, 8].map((row): [number, number] => [row, 8]),
    ...[7, 5, 4, 3, 2, 1, 0].map((column): [number, number] => [8, column]),
  ];
  const second: [number, number][] = [
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((index): [number, number] => [
      8,
      size - 1 - index,
    ]),
    ...[6, 5, 4, 3, 2, 1, 0].map((index): [number, number] => [
      size - 1 - index,
      8,
    ]),
  ];
  return [...first, ...second];
}

function formatBits(mask: number): number {
  let remainder = mask;
  for (let step = 0; step < 10; step += 1)
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((mask << 10) | remainder) ^ 0x5412;
}

function versionBits(version: number): number {
  let remainder = version;
  for (let step = 0; step < 12; step += 1)
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  return (version << 12) | remainder;
}

function formatInformation(canvas: Canvas, mask: number): void {
  const format = formatBits(mask);
  formatPlaces(canvas.size).forEach(([row, column], index) => {
    mark(canvas, [row, column, ((format >>> (index % 15)) & 1) === 1]);
  });
  mark(canvas, [canvas.size - 8, 8, true]);
}

function versionInformation(canvas: Canvas, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let index = 0; index < 18; index += 1) {
    const near = Math.floor(index / 3);
    const far = canvas.size - 11 + (index % 3);
    const dark = ((bits >>> index) & 1) === 1;
    mark(canvas, [near, far, dark]);
    mark(canvas, [far, near, dark]);
  }
}

function columnPairs(size: number): readonly number[] {
  const columns: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    columns.push(right);
  }
  return columns;
}

function dataPlaces(canvas: Canvas): readonly (readonly [number, number])[] {
  return columnPairs(canvas.size).flatMap((right) => {
    const upward = ((right + 1) & 2) === 0;
    return Array.from({ length: canvas.size }, (_, step) =>
      upward ? canvas.size - 1 - step : step,
    )
      .flatMap((row) =>
        [right, right - 1].map((column): [number, number] => [row, column]),
      )
      .filter(([row, column]) => canvas.reserved[row]?.[column] !== true);
  });
}

function placeData(canvas: Canvas, codewords: readonly number[]): void {
  dataPlaces(canvas).forEach(([row, column], index) => {
    const codeword = codewords[Math.floor(index / 8)] ?? 0;
    const modules = canvas.modules[row];
    if (modules !== undefined)
      modules[column] = ((codeword >>> (7 - (index % 8))) & 1) === 1;
  });
}

function masked(canvas: Canvas, mask: number): boolean[][] {
  const condition = masks[mask] ?? (() => false);
  return canvas.modules.map((row, rowIndex) =>
    row.map((dark, column) =>
      canvas.reserved[rowIndex]?.[column] === true
        ? dark
        : dark !== condition(rowIndex, column),
    ),
  );
}

function maskedCanvas(canvas: Canvas, mask: number): Canvas {
  const candidate: Canvas = { ...canvas, modules: masked(canvas, mask) };
  formatInformation(candidate, mask);
  return candidate;
}

export function qrMatrix(text: string): QrSymbol {
  const { version, codewords } = qrCodewords(text);
  const size = 17 + 4 * version;
  const canvas: Canvas = { size, modules: grid(size), reserved: grid(size) };
  functionPatterns(canvas, version);
  formatInformation(canvas, 0);
  versionInformation(canvas, version);
  placeData(canvas, codewords);
  const penalties = masks.map((_, mask) =>
    qrPenalty(maskedCanvas(canvas, mask).modules),
  );
  const mask = penalties.indexOf(Math.min(...penalties));
  return { version, mask, modules: maskedCanvas(canvas, mask).modules };
}
