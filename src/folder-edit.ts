// Edits ffmpeg-build.yml in place (text splices: comments and layout everywhere else stay), and finds what targets
// could add. Adding to a base reaches every target that uses it; adding to a target reaches only that build.
import { isMap, isScalar, isSeq, type Document, type Pair, type YAMLMap } from 'yaml';
import { alwaysBuilt, knownMajors, optionsOf, resolveName, type EngineData } from './engine-data.ts';
import { applySplices, documentOf, EditError, flowList, itemLines, lineEnd, lineStart, range, type Splice } from './profile-edit.ts';
import { availability, type Cell } from './resolve.ts';
import { FOLDER_FILE, parseFolderText, type Folder } from './targets.ts';
import { compareVersions, inSeries } from './versions.ts';

type Layer = { kind: 'base' | 'target'; map: YAMLMap; pair: Pair };

/** The base or target called `name` (a name used for both is ambiguous). */
function findLayer(doc: Document, name: string): Layer {
  const top = doc.contents;
  const under = (section: string) => {
    if (!isMap(top)) return undefined;
    const sec = top.get(section, true);
    if (!isMap(sec)) return undefined;
    const pair = sec.items.find((p) => isScalar(p.key) && p.key.value === name) as Pair | undefined;
    return pair && isMap(pair.value) ? { map: pair.value, pair } : undefined;
  };
  const base = under('bases');
  const target = under('targets');
  if (base && target) throw new EditError(`${name} is both a base and a target in ${FOLDER_FILE}; rename one`);
  if (base) return { kind: 'base', ...base };
  if (target) return { kind: 'target', ...target };
  throw new EditError(`there is no base or target ${name} in ${FOLDER_FILE}`);
}

const names = (seq: unknown): string[] => (isSeq(seq) ? seq.items.map((i) => (isScalar(i) ? String(i.value) : '')) : []);

/** Adds names to a layer's list (`with` or `without`), creating the list if needed. */
function addNames(text: string, layer: Layer, key: 'with' | 'without', add: string[]): string {
  const seq = layer.map.get(key, true);
  const fresh = add.filter((n) => !names(seq).includes(n));
  if (!fresh.length) return text;
  if (isSeq(seq)) {
    if (seq.flow) {
      const close = text.lastIndexOf(']', range(seq)[1]);
      return applySplices(text, [{ from: close, to: close, text: (seq.items.length ? ', ' : '') + fresh.join(', ') }]);
    }
    const last = seq.items.at(-1)!;
    const dash = text.lastIndexOf('-', range(last)[0]);
    const indent = ' '.repeat(dash - lineStart(text, dash));
    const at = lineEnd(text, range(last)[1] - 1);
    return applySplices(text, [{ from: at, to: at, text: fresh.map((n) => `${indent}- ${n}\n`).join('') }]);
  }
  if (layer.map.flow) {
    const close = text.lastIndexOf('}', range(layer.map)[1]);
    const before = text.slice(0, close).trimEnd();
    const at = before.length;
    return applySplices(text, [{ from: at, to: close, text: `${layer.map.items.length ? ', ' : ''}${key}: ${flowList(fresh)} ` }]);
  }
  const lastPair = layer.map.items.at(-1)!;
  const keyNode = layer.map.items[0]!.key as { range: [number, number, number] };
  const indent = ' '.repeat(keyNode.range[0] - lineStart(text, keyNode.range[0]));
  const end = lastPair.value && (lastPair.value as { range?: [number, number, number] }).range ? (lastPair.value as { range: [number, number, number] }).range[2] : (lastPair.key as { range: [number, number, number] }).range[2];
  const at = lineEnd(text, end - 1);
  return applySplices(text, [{ from: at, to: at, text: `${indent}${key}: ${flowList(fresh)}\n` }]);
}

/** Takes names out of a layer's list; an emptied list is written `[]`. */
function removeNames(text: string, layer: Layer, key: 'with' | 'without', drop: string[]): string {
  const seq = layer.map.get(key, true);
  if (!isSeq(seq)) return text;
  const items = seq.items.filter((i) => isScalar(i) && drop.includes(String(i.value)));
  if (!items.length) return text;
  if (seq.flow) {
    const kept = seq.items.filter((i) => !items.includes(i)).map((i) => text.slice(range(i)[0], range(i)[1]));
    return applySplices(text, [{ from: range(seq)[0], to: range(seq)[1], text: `[${kept.join(', ')}]` }]);
  }
  const splices: Splice[] = items.map((i) => itemLines(text, i));
  if (items.length === seq.items.length) {
    const pair = layer.map.items.find((p) => p.value === seq)!;
    const colon = text.indexOf(':', (pair.key as { range: [number, number, number] }).range[1]);
    splices.push({ from: colon + 1, to: colon + 1, text: ' []' });
  }
  return applySplices(text, splices);
}

const reparse = (text: string, name: string) => findLayer(documentOf(text), name);

/** `profile add <names> --to <layer>`: the names join the layer's with: (and leave its without:). */
export function addTo(text: string, layerName: string, add: string[]): string {
  let out = removeNames(text, findLayer(documentOf(text), layerName), 'without', add);
  out = addNames(out, reparse(out, layerName), 'with', add);
  return out;
}

/**
 * `profile remove <names> --from <layer>`: a base drops them from its with:; a target drops them from its own with:
 * and, where a base still gives them to it, turns them down in its without:.
 */
export function removeFrom(text: string, layerName: string, drop: string[]): string {
  const layer = findLayer(documentOf(text), layerName);
  let out = removeNames(text, layer, 'with', drop);
  if (layer.kind === 'target') {
    const parsed = parseFolderText(out, '.');
    const t = parsed.ok ? parsed.folder.targets.find((x) => x.name === layerName) : undefined;
    const still = drop.filter((n) => t?.with.includes(n));
    if (still.length) out = addNames(out, reparse(out, layerName), 'without', still);
  }
  return out;
}

/** The targets each base and target name reaches: a base, every target using it; a target, itself. */
export function targetsReached(folder: Folder, layerName: string): string[] {
  if (layerName in folder.bases) return folder.targets.filter((t) => t.base.includes(layerName)).map((t) => t.name);
  return folder.targets.some((t) => t.name === layerName) ? [layerName] : [];
}

/**
 * For each option FFmpeg offers, the targets that could build it but neither list nor turn it down (FFmpeg's
 * always-built parts aside). A target is one build, so "could build" is a plain yes or no.
 */
export function missingByTarget(folder: Folder, data: EngineData, only?: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const t of folder.targets.filter((x) => !only || x.name === only)) {
    const major = t.ffmpeg === 'latest' ? knownMajors(data).at(-1)! : t.ffmpeg.split('.')[0]!;
    const releases = (data.ffmpeg.get(major)?.releases ?? []).filter((r) => t.ffmpeg === 'latest' || inSeries(r, t.ffmpeg));
    const version = [...releases].sort(compareVersions).at(-1);
    if (!version) continue;
    const cell: Cell = { series: t.ffmpeg, major, version, license: t.license, platform: t.platform };
    const listed = new Set([...t.with, ...t.without].map((n) => resolveName(data, n) ?? n));
    for (const o of optionsOf(data, major).values()) {
      if (alwaysBuilt(o) || listed.has(o.name) || availability(data, cell, o.name)) continue;
      found.set(o.name, [...(found.get(o.name) ?? []), t.name]);
    }
  }
  return new Map([...found].sort(([a], [b]) => a.localeCompare(b)));
}
