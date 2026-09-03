import { describe, it, expect } from 'vitest';
import { parseDotenv, serializeDotenv, MAX_ENV_VARS } from '../lib/dotenv';

describe('parseDotenv', () => {
  it('parses KEY=value pairs and skips comments/blank lines', () => {
    const { vars, errors } = parseDotenv(
      '# app config\n\nDATABASE_URL=postgres://db\n\n# tune\nLOG_LEVEL=info\n',
    );
    expect(vars.DATABASE_URL).toBe('postgres://db');
    expect(vars.LOG_LEVEL).toBe('info');
    expect(errors).toEqual([]);
  });

  it('splits on the first = so values may contain equals', () => {
    const { vars, errors } = parseDotenv('CONN=a=b=c');
    expect(vars.CONN).toBe('a=b=c');
    expect(errors).toEqual([]);
  });

  it('strips optional export prefix and surrounding quotes', () => {
    const { vars, errors } = parseDotenv(
      'export PLAIN=bare\nQUOTED="double value"\nSINGLE=\'single value\'',
    );
    expect(vars.PLAIN).toBe('bare');
    expect(errors).toEqual([]);
    expect(Object.keys(vars).sort()).toEqual(['PLAIN', 'QUOTED', 'SINGLE']);
  });

  it('rejects invalid names with line numbers', () => {
    const { vars, errors } = parseDotenv('GOOD=1\n2BAD=x\nBAD-NAME=y');
    expect(vars.GOOD).toBe('1');
    expect(errors.some(e => e.includes('Line 2') && e.includes('2BAD'))).toBe(true);
    expect(errors.some(e => e.includes('BAD-NAME'))).toBe(true);
  });

  it('flags lines without = and duplicate keys', () => {
    const { errors } = parseDotenv('NOSEPARATOR\nA=1\nA=2');
    expect(errors.some(e => e.includes('Line 1') && e.includes('expected KEY=value'))).toBe(true);
    expect(errors.some(e => e.includes("duplicate name 'A'"))).toBe(true);
  });

  it('enforces the 64-var limit', () => {
    const text = Array.from({ length: MAX_ENV_VARS + 1 }, (_, i) => `K${i}=v`).join('\n');
    const { errors } = parseDotenv(text);
    expect(errors.some(e => e.includes('At most 64'))).toBe(true);
  });

  it('keeps empty values and values with # inside', () => {
    const { vars, errors } = parseDotenv('EMPTY=\nHASH=a#b');
    expect(vars.EMPTY).toBe('');
    expect(vars.HASH).toBe('a#b');
    expect(errors).toEqual([]);
  });
});

describe('serializeDotenv', () => {
  it('sorts keys and quotes values with whitespace', () => {
    const out = serializeDotenv({ Z_LAST: '1', A_FIRST: 'hello world', MID: 'plain' });
    const lines = out.split('\n');
    expect(lines[0]).toBe('A_FIRST="hello world"');
    expect(lines[1]).toBe('MID=plain');
    expect(lines[2]).toBe('Z_LAST=1');
  });

  it('round-trips through parse', () => {
    const original = { A: 'x=y', B: 'two words', C: '' };
    const round = parseDotenv(serializeDotenv(original));
    expect(round.errors).toEqual([]);
    expect(round.vars).toEqual(original);
  });
});
