export interface QrPicture {
  readonly size: number;
  readonly path: string;
}

const quietZone = 4;

function rowPath(row: readonly boolean[], top: number): string {
  let path = "";
  let start = 0;
  while (start < row.length) {
    if (row[start] !== true) {
      start += 1;
      continue;
    }
    let end = start;
    while (row[end] === true) end += 1;
    const width = String(end - start);
    path += `M${String(start + quietZone)} ${String(top + quietZone)}h${width}v1h-${width}z`;
    start = end;
  }
  return path;
}

export function qrPicture(modules: readonly (readonly boolean[])[]): QrPicture {
  return {
    size: modules.length + 2 * quietZone,
    path: modules.map((row, top) => rowPath(row, top)).join(""),
  };
}
