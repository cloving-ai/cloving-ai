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

export function queueSpending(
  costs: readonly number[],
  limitUsd: number,
): { readonly spentUsd: number; readonly holding: boolean } {
  const prices = costs.map(decimal);
  const limit = decimal(limitUsd);
  const exponent = prices.reduce(
    (smallest, price) => Math.min(smallest, price.exponent),
    limit.exponent,
  );
  const total = prices.reduce(
    (sum, price) => sum + scaled(price, exponent),
    0n,
  );
  return {
    spentUsd: Number(`${String(total)}e${String(exponent)}`),
    holding: total * 100n >= scaled(limit, exponent) * 85n,
  };
}
