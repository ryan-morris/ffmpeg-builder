import { describe, expect, it } from 'vitest';
import { compareVersions, inSeries, isFfmpegSeries, isVersion, isVersionCondition, matchesVersionCondition } from '../src/versions.ts';

describe('versions', () => {
  it('compares dotted numbers numerically', () => {
    expect(compareVersions('9.10', '9.9')).toBe(1);
    expect(compareVersions('13.0.19.1', '13.0')).toBe(1);
    expect(compareVersions('9.0', '9.0.0')).toBe(0);
    expect(compareVersions('8.1.3', '9')).toBe(-1);
  });

  it('recognises versions and FFmpeg series', () => {
    expect(isVersion('9.0.2')).toBe(true);
    expect(isVersion('v9')).toBe(false);
    expect(isFfmpegSeries('9')).toBe(true);
    expect(isFfmpegSeries('9.0')).toBe(true);
    expect(isFfmpegSeries('latest')).toBe(true);
    expect(isFfmpegSeries('9.0.2')).toBe(false);
    expect(isFfmpegSeries('nine')).toBe(false);
    expect(isFfmpegSeries('09')).toBe(false);
    expect(isFfmpegSeries('9.00')).toBe(false);
  });

  it('checks series membership', () => {
    expect(inSeries('9.0.2', '9')).toBe(true);
    expect(inSeries('9.0.2', '9.0')).toBe(true);
    expect(inSeries('9.1.0', '9.0')).toBe(false);
  });

  it('evaluates conditions series-aware', () => {
    expect(matchesVersionCondition('8.0.0', '>=8')).toBe(true);
    expect(matchesVersionCondition('8.1.3', '>8')).toBe(false);
    expect(matchesVersionCondition('9.0.2', '>8')).toBe(true);
    expect(matchesVersionCondition('8.1.3', '<=8')).toBe(true);
    expect(matchesVersionCondition('9.0.2', '<9')).toBe(false);
    expect(matchesVersionCondition('9.0.2', '9.0')).toBe(true);
    expect(matchesVersionCondition('9.1.0', '= 9.0')).toBe(false);
    expect(isVersionCondition('>=8')).toBe(true);
    expect(isVersionCondition('~8')).toBe(false);
    expect(isVersionCondition('>=08')).toBe(false);
  });
});
