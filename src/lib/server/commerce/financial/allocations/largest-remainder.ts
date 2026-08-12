export interface SignedLargestRemainderInput {
  readonly amountMinor: number;
  readonly weights: readonly { readonly tieKey: string; readonly weightMinor: number }[];
}

export interface SignedLargestRemainderAllocation {
  readonly tieKey: string;
  readonly amountMinor: number;
}

function compareTieKey(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]!.codePointAt(0)!;
    const rightPoint = rightPoints[index]!.codePointAt(0)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  return leftPoints.length - rightPoints.length;
}

export function allocateSignedLargestRemainder(
  input: SignedLargestRemainderInput
): readonly SignedLargestRemainderAllocation[] {
  if (!Number.isSafeInteger(input.amountMinor)) throw new PermanentFinancialError('allocation_mismatch');
  const seen = new Set<string>();
  const weights = input.weights.map((weight) => {
    if (
      weight.tieKey.length === 0 ||
      seen.has(weight.tieKey) ||
      !Number.isSafeInteger(weight.weightMinor) ||
      weight.weightMinor < 0
    ) throw new PermanentFinancialError('allocation_mismatch');
    seen.add(weight.tieKey);
    return weight;
  }).filter((weight) => weight.weightMinor > 0);
  if (weights.length === 0) {
    if (input.amountMinor !== 0) throw new PermanentFinancialError('allocation_mismatch');
    return [];
  }

  const totalWeight = weights.reduce((sum, weight) => sum + BigInt(weight.weightMinor), 0n);
  const absoluteAmount = input.amountMinor < 0
    ? -BigInt(input.amountMinor)
    : BigInt(input.amountMinor);
  const sign = input.amountMinor < 0 ? -1n : 1n;
  const rows = weights.map((weight) => {
    const numerator = absoluteAmount * BigInt(weight.weightMinor);
    return {
      tieKey: weight.tieKey,
      allocated: numerator / totalWeight,
      remainder: numerator % totalWeight
    };
  });
  let undistributed = absoluteAmount - rows.reduce((sum, row) => sum + row.allocated, 0n);
  const remainderOrder = [...rows].sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
    return compareTieKey(left.tieKey, right.tieKey);
  });
  for (const row of remainderOrder) {
    if (undistributed === 0n) break;
    row.allocated += 1n;
    undistributed -= 1n;
  }
  const result = rows.sort((left, right) => compareTieKey(left.tieKey, right.tieKey)).map((row) => {
    const signed = row.allocated * sign;
    const amountMinor = Number(signed);
    if (!Number.isSafeInteger(amountMinor)) throw new PermanentFinancialError('allocation_mismatch');
    return { tieKey: row.tieKey, amountMinor };
  });
  if (result.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n) !== BigInt(input.amountMinor)) {
    throw new PermanentFinancialError('allocation_mismatch');
  }
  return result;
}
import { PermanentFinancialError } from '../errors';
