/** Length-checked XOR compare. A length mismatch still walks both buffers. */
export function timingSafeEqualString(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length, 1);
  let diff = a.length === b.length ? 0 : 1;
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

export function secretsMatch(provided: string | null, expected: string | undefined): boolean {
  const providedValue = provided ?? '';
  const expectedValue = expected ?? '';
  if (!providedValue || !expectedValue) {
    timingSafeEqualString(providedValue || ' ', expectedValue || ' ');
    return false;
  }
  return timingSafeEqualString(providedValue, expectedValue);
}
