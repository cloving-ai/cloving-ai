interface Decimal {
  readonly units: bigint;
  readonly exponent: number;
}

function decimal(value: number): Decimal {
  const [mantissa = "0", exponent = "0"] = String(value).split("e");
  const fraction = mantissa.split(".")[1]?.length ?? 0;
  return {
    units: BigInt(mantissa.replace(".", "")),
    exponent: Number(exponent) - fraction,
  };
}

function scaled(value: Decimal, exponent: number): bigint {
  return value.units * 10n ** BigInt(value.exponent - exponent);
}

function summed(values: readonly Decimal[]): Decimal {
  const exponent = values.reduce(
    (smallest, value) => Math.min(smallest, value.exponent),
    0,
  );
  return {
    units: values.reduce((sum, value) => sum + scaled(value, exponent), 0n),
    exponent,
  };
}

function numberOf(value: Decimal): number {
  return Number(`${String(value.units)}e${String(value.exponent)}`);
}

export function costTotal(costs: readonly number[]): number {
  return numberOf(summed(costs.map(decimal)));
}

export function queueSpending(
  costs: readonly number[],
  limitUsd: number,
): { readonly spentUsd: number; readonly holding: boolean } {
  const limit = decimal(limitUsd);
  const total = summed(costs.map(decimal));
  const exponent = Math.min(total.exponent, limit.exponent);
  return {
    spentUsd: numberOf(total),
    holding: scaled(total, exponent) * 100n >= scaled(limit, exponent) * 85n,
  };
}
