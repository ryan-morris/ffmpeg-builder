import { describe, expect, it } from 'vitest';
import { isCommit, isRange, satisfies } from '../src/ranges.ts';

describe('pin ranges', () => {
  const cases: [string, string, boolean][] = [
    ['4.3.1', '4.3.1', true], ['4.3.2', '4.3.1', false],
    ['4.3.7', '4.3', true], ['4.4.0', '4.3', false],
    ['13.0.19.1', '13.0', true], ['13.1.15.0', '13.0', false],
    ['13.9', '13', true], ['14.0', '13', false],
    ['1.2.3', '=1.2', true],
    ['1.5.9', '~1.5.4', true], ['1.5.3', '~1.5.4', false], ['1.6.0', '~1.5.4', false],
    ['1.9.0', '^1.5.4', true], ['2.0.0', '^1.5.4', false], ['1.5.3', '^1.5.4', false],
    ['0.17.9', '^0.17.2', true], ['0.18.0', '^0.17.2', false],
    ['3.6.7', '>=3.6 <4', true], ['4.0.0', '>=3.6 <4', false], ['3.5.9', '>=3.6 <4', false],
    ['1.3.0', '>1.2', true], ['1.2.9', '>1.2', false],
    ['2.9.9', '<=2', true], ['3.0', '<=2', false],
    ['4.5.1', '4.3 || 4.5', true], ['4.4.0', '4.3 || 4.5', false],
    ['1.05', '1.5', true],
    // the parts you write must match: exact for a library with three-part versions, a prefix for longer ones
    ['4.3.1.7', '4.3.1', true],
    ['13.0.19.1', '13.0.19.1', true], ['13.0.19.2', '13.0.19.1', false],
  ];
  it.each(cases)('%s in "%s" is %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it('never matches something that is not a version, or a range that is not valid', () => {
    expect(satisfies('1.6.0-rc1', '1.6')).toBe(false);
    expect(satisfies('13.1.0', '13.x')).toBe(false);
    expect(satisfies('1.2.3', 'b35605ace3ddf7c1a5d67a2eb553f034aef41d55')).toBe(false);
  });

  it('knows what a range looks like', () => {
    for (const ok of ['4.3', '4.3.1', '13', '=1.2', '~1.5.4', '^1.5.4', '>=3.6 <4', '4.3 || 4.5', ' 4.3 ']) expect(isRange(ok), ok).toBe(true);
    for (const bad of ['', 'latest', '1.x', '>= 3.6', '4.3 ||', '~>1.2', 'v1.2']) expect(isRange(bad), bad).toBe(false);
  });

  it('knows a full commit hash', () => {
    expect(isCommit('b35605ace3ddf7c1a5d67a2eb553f034aef41d55')).toBe(true);
    expect(isCommit('b35605a')).toBe(false);
    expect(isCommit('B35605ACE3DDF7C1A5D67A2EB553F034AEF41D55')).toBe(false);
  });
});
