import { describe, it, expect } from 'vitest';
import { daysToNanoseconds } from './duration';

describe('daysToNanoseconds', () => {
  it('converts 30 days to nanoseconds (Gitness token lifetime unit)', () => {
    expect(daysToNanoseconds(30)).toBe(2592000000000000);
  });

  it('converts 1 day to nanoseconds', () => {
    expect(daysToNanoseconds(1)).toBe(86400000000000);
  });
});
