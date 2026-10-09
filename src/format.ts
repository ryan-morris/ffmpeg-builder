import type { ProfileReport } from './check.ts';
import { versionInCell } from './choose.ts';
import type { EngineData } from './engine-data.ts';
import type { LockedProfile } from './lockfile.ts';
import { isCommit } from './ranges.ts';
import { describePlatforms } from './platforms.ts';
import type { Profile } from './profile.ts';
import type { ProfilePlan } from './resolve.ts';
import { seriesLabel } from './text.ts';

/** A report's problems as one line each ("pin: schannel: schannel is part of FFmpeg itself; ..."). */
export function problemLines(report: ProfileReport): string[] {
  return report.blocks.flatMap((block) =>
    block.lines
      .filter((line) => line.mark === '✗')
      .map((line) => [block.title, line.text, ...(line.detail ?? [])].filter(Boolean).join(': ')),
  );
}

export function formatReport(report: ProfileReport): string {
  const out = [report.header];
  for (const block of report.blocks) {
    const indent = block.title ? '    ' : '  ';
    if (block.title) out.push(`  ${block.title}`);
    for (const line of block.lines) {
      out.push(`${indent}${line.mark} ${line.text}${line.note ? `   (${line.note})` : ''}`);
      for (const d of line.detail ?? []) out.push(`${indent}    ${d}`);
    }
  }
  if (report.problems) out.push('', `${report.problems} problem${report.problems === 1 ? '' : 's'} in ${report.file}.`);
  return out.join('\n');
}

const shortVersionOf = (v: string) => (isCommit(v) ? v.slice(0, 12) : v);

export function formatPlan(profile: Profile, plan: ProfilePlan, data: EngineData, locked?: LockedProfile): string {
  const out = [profile.file];
  for (const v of plan.variants) {
    out.push(`  FFmpeg ${seriesLabel(v)} (${v.version}) · ${v.license}`);
    const rows = new Map<string, { platforms: string[]; options: string[]; recipes: string[]; pins: Record<string, string> }>();
    for (const c of plan.cells.filter((c) => c.cell.series === v.series && c.cell.license === v.license)) {
      const libraries = c.recipes.map((r) => (locked ? `${r} ${shortVersionOf(versionInCell(profile, data, locked, c.cell, r) ?? '?')}` : r));
      const key = JSON.stringify([c.options, libraries, c.pins]);
      const row = rows.get(key) ?? { platforms: [], options: c.options, recipes: libraries, pins: c.pins };
      row.platforms.push(c.cell.platform);
      rows.set(key, row);
    }
    for (const row of rows.values()) {
      out.push(`    ${describePlatforms(row.platforms)}`);
      out.push(`      options:   ${row.options.join(', ') || "(FFmpeg's built-ins only)"}`);
      out.push(`      libraries: ${row.recipes.join(', ') || '(none)'}`);
      const pinned = Object.entries(row.pins).map(([lib, ver]) => `${lib} ${ver}`);
      if (pinned.length) out.push(`      pinned:    ${pinned.join(', ')}`);
    }
  }
  return out.join('\n');
}

export function planJson(profile: Profile, plan: ProfilePlan, data: EngineData, locked?: LockedProfile) {
  return {
    profile: profile.name,
    file: profile.file,
    builds: plan.cells.map((c) => ({
      ffmpeg: c.cell.version,
      series: c.cell.series,
      license: c.cell.license,
      platform: c.cell.platform,
      options: c.options,
      libraries: c.recipes,
      pinned: c.pins,
      ...(locked ? { versions: Object.fromEntries(c.recipes.map((r) => [r, versionInCell(profile, data, locked, c.cell, r) ?? '?'])) } : {}),
    })),
  };
}
