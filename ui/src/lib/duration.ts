// Gitness token lifetimes are Go time.Duration values, serialized as nanoseconds.
export function daysToNanoseconds(days: number): number {
  return days * 24 * 60 * 60 * 1_000_000_000;
}
