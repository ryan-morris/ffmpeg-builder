import { z } from 'zod';
import { name, oneOrMany, text } from './common.ts';

export const LICENSES = ['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree'] as const;
export type License = (typeof LICENSES)[number];
const license = z.enum(LICENSES, { error: `expected one of ${LICENSES.join(', ')}` });

export const conditionShape = {
  ffmpeg: oneOrMany(text, 'expected a version condition like ">=8", or a list of them').optional(),
  platforms: oneOrMany(text, 'expected a platform pattern like win-*, or a list of them').optional(),
  license: oneOrMany(license, `expected one of ${LICENSES.join(', ')}, or a list of them`).optional(),
};
const condition = z.strictObject(conditionShape);
export type Condition = z.output<typeof condition>;

export interface Entry { name: string; cond?: Condition }
export interface PinEntry { name: string; version: string; cond?: Condition }

/** `{}` is the same as no condition. */
const orNone = (cond: Condition): Condition | undefined => (Object.keys(cond).length ? cond : undefined);

const single = <T extends z.ZodType>(value: T) =>
  z.record(name, value).refine((o) => Object.keys(o).length === 1, { error: 'each entry names exactly one thing' });

export const entry = z.union(
  [
    name.transform((n): Entry => ({ name: n })),
    single(condition).transform((o): Entry => {
      const [n, cond] = Object.entries(o)[0]!;
      const c = orNone(cond as Condition);
      return c ? { name: n, cond: c } : { name: n };
    }),
  ],
  { error: 'expected a name, or a name with a condition like `whisper: { ffmpeg: ">=8" }`' },
);

const entries = z.array(entry, { error: 'expected a list, like [nvenc, x265], with conditions written as `- whisper: { ffmpeg: ">=8" }`' });

const pinValue = z.union(
  [
    text.transform((v) => ({ version: v })),
    z.strictObject({ ...conditionShape, version: text }).transform(({ version, ...cond }) => {
      const c = orNone(cond as Condition);
      return c ? { version, cond: c } : { version };
    }),
  ],
  { error: 'expected a version like "13.0", or { version: "7.349", platforms: [...] }' },
);
const pins = z.union(
  [
    z.array(single(pinValue).transform((o): PinEntry => {
      const [n, v] = Object.entries(o)[0]!;
      return { name: n, ...(v as Omit<PinEntry, 'name'>) };
    })),
    z.record(name, pinValue).transform((o) => Object.entries(o).map(([n, v]): PinEntry => ({ name: n, ...(v as Omit<PinEntry, 'name'>) }))),
  ],
  { error: 'expected a list of pins like `- nvenc: "13.0"`' },
);

export const profileSchema = z.strictObject({
  name: z.string({ error: 'expected a name' }).regex(/^[a-z0-9][a-z0-9-]*$/, {
    error: 'expected a short lowercase name like dvr (it is used in tags and file names)',
  }),
  ffmpeg: oneOrMany(text, 'expected an FFmpeg series like 9, 9.0 or latest, or a list of them'),
  platforms: oneOrMany(text, 'expected all, or a list of platforms like linux-x64 or win-*'),
  license: oneOrMany(license, `expected one of ${LICENSES.join(', ')}, or a list of them`),
  with: entries.default([]),
  without: entries.default([]),
  pin: pins.default([]),
  patches: oneOrMany(text, 'expected a patch folder like patches/acme-muxer, or a list of them').default([]),
  tests: oneOrMany(text, 'expected a test command like ./tests/roundtrip.sh, or a list of them').default([]),
});
export type ProfileData = z.output<typeof profileSchema>;
