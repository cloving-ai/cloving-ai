type Line = readonly boolean[];

interface Runs {
  readonly size: number;
  readonly history: number[];
}

function added(runs: Runs, length: number): void {
  runs.history.unshift(runs.history[0] === 0 ? length + runs.size : length);
  runs.history.length = 7;
}

function finderLike(history: readonly number[]): number {
  const at = (index: number): number => history[index] ?? 0;
  const unit = at(1);
  const core =
    unit > 0 &&
    [at(2), at(4), at(5)].every((run) => run === unit) &&
    at(3) === unit * 3;
  if (!core) return 0;
  return (
    Number(at(0) >= unit * 4 && at(6) >= unit) +
    Number(at(6) >= unit * 4 && at(0) >= unit)
  );
}

function lineScore(line: Line): number {
  const runs: Runs = { size: line.length, history: [0, 0, 0, 0, 0, 0, 0] };
  let score = 0;
  let color = false;
  let length = 0;
  for (const dark of line) {
    if (dark === color) {
      length += 1;
      score += length === 5 ? 3 : Number(length > 5);
      continue;
    }
    added(runs, length);
    if (!color) score += finderLike(runs.history) * 40;
    color = dark;
    length = 1;
  }
  if (color) {
    added(runs, length);
    length = 0;
  }
  added(runs, length + line.length);
  return score + finderLike(runs.history) * 40;
}

function blocks(modules: readonly Line[]): number {
  let score = 0;
  modules.forEach((row, rowIndex) => {
    const below = modules[rowIndex + 1];
    for (let column = 0; column < row.length; column += 1) {
      const dark = row[column];
      const same =
        below !== undefined &&
        dark === row[column + 1] &&
        dark === below[column] &&
        dark === below[column + 1];
      if (same) score += 3;
    }
  });
  return score;
}

function balance(modules: readonly Line[]): number {
  const total = modules.length ** 2;
  const dark = modules.flat().filter(Boolean).length;
  return (
    10 *
    (Math.floor((Math.abs(dark * 20 - total * 10) + total - 1) / total) - 1)
  );
}

export function qrPenalty(modules: readonly Line[]): number {
  const columns = modules.map((_, column) =>
    modules.map((row) => row[column] === true),
  );
  return (
    [...modules, ...columns].reduce(
      (total, line) => total + lineScore(line),
      0,
    ) +
    blocks(modules) +
    balance(modules)
  );
}
