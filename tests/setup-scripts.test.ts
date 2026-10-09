// The platform setup scripts (platforms/setup/*.sh) as the driver and recipes use them, run with the host's bash.
// They need GNU sed; the suite skips them where bash isn't available.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageRoot } from '../src/paths.ts';

const hasBash = (() => {
  try {
    execFileSync('bash', ['-c', 'sed --version >/dev/null'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Runs `script` in bash with ENGINE pointing at this repo's platforms/ folder; returns stdout (throws on failure). */
function bash(script: string, env: Record<string, string>): string {
  const file = join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-sh-')), 'run.sh');
  writeFileSync(file, `set -euo pipefail\n${script}\n`);
  return execFileSync('bash', [file], { encoding: 'utf8', env: { ...process.env, ENGINE: join(packageRoot, 'platforms'), ...env } });
}

describe.skipIf(!hasBash)('the musl setup', () => {
  const deps = () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-deps-'));
    mkdirSync(join(dir, 'lib', 'pkgconfig'), { recursive: true });
    return dir.replaceAll('\\', '/');
  };

  it('prepares FFmpeg even when the build has no libraries', () => {
    expect(bash('source "${ENGINE}/setup/linux-musl.sh"; before_ffmpeg; echo ok', { DEPS_DIR: deps() }).trim()).toBe('ok');
  });

  it('links libstdc++ statically everywhere a .pc file names it, adjacent copies too, and drops -lgcc_s', () => {
    const dir = deps();
    const pc = join(dir, 'lib', 'pkgconfig', 'x.pc');
    writeFileSync(pc, 'Libs.private: -lstdc++ -lstdc++ -lgcc_s -lm -lstdc++\n');
    bash('source "${ENGINE}/setup/linux-musl.sh"; before_ffmpeg', { DEPS_DIR: dir });
    const text = readFileSync(pc, 'utf8');
    bash('source "${ENGINE}/setup/linux-musl.sh"; before_ffmpeg', { DEPS_DIR: dir });
    expect(readFileSync(pc, 'utf8')).toBe(text); // a second run changes nothing
    expect(text).not.toMatch(/-lstdc\+\+(\s|$)/);
    expect(text).not.toContain('-lgcc_s');
    expect(text.match(/-l:libstdc\+\+\.a/g)).toHaveLength(3);
    expect(text).toContain('-lm');
  });
});

describe.skipIf(!hasBash)('a recipe build', () => {
  it("sees the platform's setup after recipes/lib.sh: its variables and cross arrays", () => {
    const recipes = mkdtempSync(join(tmpdir(), 'ffmpeg-build-recipes-'));
    writeFileSync(join(recipes, 'lib.sh'), readFileSync(join(packageRoot, 'recipes', 'lib.sh'), 'utf8'));
    const engine = mkdtempSync(join(tmpdir(), 'ffmpeg-build-engine-'));
    mkdirSync(join(engine, 'setup'));
    writeFileSync(join(engine, 'setup', 'probe.sh'), 'export PROBE_CC=probe-gcc\nCMAKE_CROSS_ARGS=(-DCMAKE_TOOLCHAIN_FILE=/tc.cmake)\nMESON_CROSS_ARGS=(--cross-file=/cross.txt)\n');
    // the same command line platforms/driver.sh runs for each recipe
    const out = bash(
      `bash -c 'set -euo pipefail; source "${recipes.replaceAll('\\', '/')}/lib.sh"; source "\${ENGINE}/setup/\${SETUP}.sh"; echo "\${PROBE_CC} \${CMAKE_CROSS_ARGS[*]} \${MESON_CROSS_ARGS[*]}"'`,
      { SETUP: 'probe', ENGINE: engine.replaceAll('\\', '/') },
    );
    expect(out.trim()).toBe('probe-gcc -DCMAKE_TOOLCHAIN_FILE=/tc.cmake --cross-file=/cross.txt');
  });
});

describe.skipIf(!hasBash)('the Android setup', () => {
  // An NDK whose llvm-readelf prints the library file itself, so each test writes the program headers it wants.
  const ndk = () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-ndk-'));
    const bin = join(root, 'toolchains', 'llvm', 'prebuilt', 'linux-x86_64', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'llvm-readelf'), '#!/usr/bin/env bash\ncat "${@: -1}"\n', { mode: 0o755 });
    mkdirSync(join(root, 'deps'));
    return root.replaceAll('\\', '/');
  };
  const load = (align: string) => `  LOAD           0x000000 0x0000000000000000 0x0000000000000000 0x0a1b2c 0x0a1b2c R E ${align}\n`;
  const align = (root: string, libs: Record<string, string>) => {
    for (const [name, text] of Object.entries(libs)) writeFileSync(join(root, name), text);
    const files = Object.keys(libs).map((n) => `"${root}/${n}"`).join(' ');
    return bash(`source "\${ENGINE}/setup/android.sh"; check_page_align ${files}; echo ok`, {
      ANDROID_NDK_HOME: root,
      BUILD_RID: 'android-arm64',
      DEPS_DIR: `${root}/deps`,
    });
  };

  it('accepts libraries whose LOAD segments are all aligned to 16 KB or more', () => {
    expect(align(ndk(), { 'liba.so': load('0x4000') + load('0x4000'), 'libb.so': load('0x10000') }).trim()).toBe('ok');
  });

  it('fails on a LOAD segment aligned to less than 16 KB, naming the library', () => {
    expect(() => align(ndk(), { 'liba.so': load('0x4000'), 'libb.so': load('0x4000') + load('0x1000') })).toThrow(/libb\.so.*0x1000/s);
  });

  it('fails on a library with no LOAD segments to check', () => {
    expect(() => align(ndk(), { 'liba.so': 'not an ELF file\n' })).toThrow(/liba\.so/);
  });
});
