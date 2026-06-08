export function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function parseCliPositiveInteger(flag: string, rawValue: string): number {
  const value = Number(rawValue);
  if (!isPositiveInteger(value)) {
    throw new Error(`Invalid value for ${flag}: expected a positive integer`);
  }

  return value;
}
