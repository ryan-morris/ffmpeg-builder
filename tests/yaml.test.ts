import { describe, expect, it } from 'vitest';
import { parseYaml, YamlError } from '../src/yaml.ts';

describe('parseYaml', () => {
  it('keeps every scalar a string', () => {
    expect(parseYaml('ffmpeg: 9.10\nok: true\nn: 42\nnil: ~\nlist: [8, 9]\n', 'p.yml')).toEqual({
      ffmpeg: '9.10', ok: 'true', n: '42', nil: '~', list: ['8', '9'],
    });
  });

  it('turns an empty value into an empty string', () => {
    expect(parseYaml('with:\nname: a\n', 'p.yml')).toEqual({ with: '', name: 'a' });
  });

  it('keeps quoted values and flow mappings as written', () => {
    expect(parseYaml('pin:\n  - nvenc: "13.0"\n  - x: { version: 7.349, platforms: [win-arm64] }\n', 'p.yml')).toEqual({
      pin: [{ nvenc: '13.0' }, { x: { version: '7.349', platforms: ['win-arm64'] } }],
    });
  });

  it('reads Windows files (CRLF line endings and a UTF-8 BOM) like any other', () => {
    expect(parseYaml('\uFEFFname: dvr\r\nffmpeg: 9.0\r\n', 'p.yml')).toEqual({ name: 'dvr', ffmpeg: '9.0' });
  });

  it('rejects duplicate keys, naming the file and line', () => {
    const run = () => parseYaml('name: a\nffmpeg: 9\nname: b\n', 'dup.yml');
    expect(run).toThrow(YamlError);
    expect(run).toThrow(/^dup\.yml:3: /);
  });

  it('reports syntax errors with the file name', () => {
    expect(() => parseYaml('a: [1, 2\nb: 3\n', 'bad.yml')).toThrow(/^bad\.yml:\d+: /);
  });

  it('treats an empty file as null', () => {
    expect(parseYaml('', 'empty.yml')).toBeNull();
  });
});
