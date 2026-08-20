// Curated high-risk TS shapes for the differential corpus (test/differential.test.mjs).
export function pick(s: string[], t = 0.25): { id: string; drift: boolean } {
  return { id: s[0], drift: t > 0 };
}
export function identity<T>(x: T): T { return x; }
export function pluckLength<T extends { length: number }>(arg: T): number { return arg.length; }
export const first = <T,>(arr: T[]) =>
  arr.length > 0
    ? arr[0]
    : undefined;
export function withSatisfies(): number {
  const v = { a: 1 } satisfies { a: number };
  return v.a;
}
