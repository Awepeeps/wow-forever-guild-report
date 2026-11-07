import { z } from "zod";

const text = z.string().trim().max(2_000);
const name = z.string().trim().min(1).max(100);
const characterId = z.string().regex(/^\d{1,20}$/);
export const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*$/u);
export const professionSchema = z
  .object({
    name,
    skill: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
    tier: name.optional(),
  })
  .strict()
  .refine(
    (p) => p.skill === undefined || p.max === undefined || p.skill <= p.max,
    "Skill exceeds maximum",
  );
export type Profession = z.infer<typeof professionSchema>;

export const characterSchema = z
  .object({
    slug: slugSchema,
    name,
    id: characterId.optional(),
    ruleset: text.default(""),
    class: text.default(""),
    faction: text.default(""),
    race: text.default(""),
    level: z.number().int().min(1).max(1_000).optional(),
    guildRank: z.number().int().nonnegative().max(999).optional(),
    talents: z
      .array(
        z
          .object({
            tree: name,
            points: z.number().int().nonnegative(),
            group: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    primary: z.array(professionSchema).max(100).default([]),
    secondary: z.array(professionSchema).max(100).default([]),
  })
  .strict();
export type Character = z.infer<typeof characterSchema>;
type Identity = { slug: string; id?: string | undefined };

export function characterIdentity(character: Identity): string {
  return character.id
    ? `id:${character.id}`
    : `slug:${character.slug.toLocaleLowerCase("en-US")}`;
}

// Repeated IDs alias one character; repeated slugs alias one API request path.
export function duplicateCharacterIndices(
  characters: readonly Identity[],
): number[] {
  const identities = new Set<string>();
  const slugs = new Set<string>();
  const duplicates: number[] = [];
  for (const [index, character] of characters.entries()) {
    const identity = characterIdentity(character);
    const slug = character.slug.toLocaleLowerCase("en-US");
    if (identities.has(identity) || slugs.has(slug)) duplicates.push(index);
    identities.add(identity);
    slugs.add(slug);
  }
  return duplicates;
}
// Config entries are overrides. Omission must survive parsing so it cannot clear
// last-good API data before a later request fails. Explicit [] still clears.
const characterOverrideSchema = characterSchema.extend({
  ruleset: text.optional(),
  class: text.optional(),
  faction: text.optional(),
  race: text.optional(),
  talents: characterSchema.shape.talents.removeDefault().optional(),
  primary: characterSchema.shape.primary.removeDefault().optional(),
  secondary: characterSchema.shape.secondary.removeDefault().optional(),
});
export const regionSchema = z.enum(["us", "eu", "kr", "tw"]);
const guildRankNamesSchema = z
  .record(z.string().regex(/^(?:0|[1-9]\d{0,2})$/), name)
  .default({});
export const configSchema = z
  .object({
    version: z.literal(1),
    region: regionSchema,
    locale: z
      .enum([
        "en_US",
        "es_MX",
        "pt_BR",
        "en_GB",
        "es_ES",
        "fr_FR",
        "ru_RU",
        "de_DE",
        "pt_PT",
        "it_IT",
        "ko_KR",
        "zh_TW",
      ])
      .default("en_US"),
    guild: slugSchema.optional(),
    guildRankNames: guildRankNamesSchema,
    characters: z.array(characterOverrideSchema).max(2_000).default([]),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const i of duplicateCharacterIndices(c.characters)) {
      ctx.addIssue({
        code: "custom",
        path: ["characters", i, "slug"],
        message: "Duplicate character identity",
      });
    }
  });
export type RosterConfig = z.infer<typeof configSchema>;
const statusSchema = z.enum(["manual", "ok", "unavailable", "error"]);
export const rowSchema = z
  .object({
    character: characterSchema,
    discord: text,
    profileStatus: statusSchema,
    professionStatus: statusSchema,
    talentStatus: statusSchema,
    fetchedAt: z.iso.datetime().nullable(),
    profileFetchedAt: z.iso.datetime().nullable(),
    professionFetchedAt: z.iso.datetime().nullable(),
    talentFetchedAt: z.iso.datetime().nullable(),
    issue: text,
  })
  .strict();
export type RosterRow = z.infer<typeof rowSchema>;
export const snapshotSchema = z
  .object({
    version: z.literal(1),
    region: regionSchema,
    generatedAt: z.iso.datetime(),
    guild: z.string().nullable(),
    guildRankNames: guildRankNamesSchema,
    rows: z.array(rowSchema).max(2_000),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    for (const i of duplicateCharacterIndices(
      snapshot.rows.map((row) => row.character),
    ))
      ctx.addIssue({
        code: "custom",
        path: ["rows", i, "character"],
        message: "Duplicate character identity",
      });
  });
export type Snapshot = z.infer<typeof snapshotSchema>;
export const discordMapSchema = z.record(z.string(), text);

export function characterSlug(fullName: string): string {
  return slugSchema.parse(
    fullName
      .normalize("NFC")
      .trim()
      .toLocaleLowerCase("en-US")
      .replace(/\s+/g, "-"),
  );
}

export function discordFor(
  map: Record<string, string>,
  region: string,
  slug: string,
  id?: string,
): string {
  return (
    (id ? map[`${region}:id:${id}`] : undefined) ??
    map[`${region}:${slug.toLocaleLowerCase("en-US")}`] ??
    ""
  );
}

export function sortRows(rows: RosterRow[]): RosterRow[] {
  const compare = (a: string, b: string) =>
    a.localeCompare(b, "en", { sensitivity: "base" }) ||
    a.localeCompare(b, "en");
  return rows.sort(
    (a, b) =>
      (a.character.guildRank ?? Number.MAX_SAFE_INTEGER) -
        (b.character.guildRank ?? Number.MAX_SAFE_INTEGER) ||
      Number(!a.discord) - Number(!b.discord) ||
      compare(a.discord, b.discord) ||
      compare(a.character.name, b.character.name) ||
      compare(a.character.slug, b.character.slug),
  );
}

export function manualSnapshot(
  config: RosterConfig,
  map: Record<string, string>,
  now = new Date(),
): Snapshot {
  return {
    version: 1,
    region: config.region,
    generatedAt: now.toISOString(),
    guild: config.guild ?? null,
    guildRankNames: config.guildRankNames,
    rows: sortRows(
      config.characters.map((entry) => ({
        character: characterSchema.parse(entry),
        discord: discordFor(map, config.region, entry.slug, entry.id),
        profileStatus: "manual",
        professionStatus: "manual",
        talentStatus: "manual",
        fetchedAt: null,
        profileFetchedAt: null,
        professionFetchedAt: null,
        talentFetchedAt: null,
        issue: "",
      })),
    ),
  };
}
