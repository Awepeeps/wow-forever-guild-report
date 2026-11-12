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
export const recipeSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().trim().min(1).max(200),
  })
  .strict();
export type Recipe = z.infer<typeof recipeSchema>;
export const professionSchema = z
  .object({
    name,
    skill: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
    tier: name.optional(),
    // Omitted means recipe coverage is unknown (including older snapshots).
    recipes: z.array(recipeSchema).max(10_000).optional(),
    recipesRetained: z.boolean().optional(),
    recipesFetchedAt: z.iso.datetime().nullable().optional(),
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
    equippedItemLevel: z.number().int().nonnegative().optional(),
    averageItemLevel: z.number().int().nonnegative().optional(),
    lastLoginAt: z.iso.datetime().optional(),
    achievementPoints: z.number().int().nonnegative().optional(),
    experience: z.number().int().nonnegative().optional(),
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
export function hasRetainedRecipes(character: Character): boolean {
  return [...character.primary, ...character.secondary].some(
    (p) => p.recipesRetained,
  );
}
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
export const reportTimeZoneSchema = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, "Invalid report timezone");
const guildRankNamesSchema = z
  .record(z.string().regex(/^(?:0|[1-9]\d{0,2})$/), name)
  .default({});
export const auctionMarketSchema = z
  .object({
    rulesetId: z.number().int().positive().max(999),
    rulesetName: name,
    faction: z.enum(["Alliance", "Horde", "Blackwater"]),
    houseId: z.number().int().positive().max(1_000_000),
    verifiedAt: z.iso.datetime(),
    verification: z.literal("in-game-listings"),
    // Seller's cut on a completed sale, e.g. 5 for faction houses per client
    // AuctionHouse.ConsignmentRate. Omitted means margins are shown before the cut.
    saleCutPercent: z.number().min(0).max(100).optional(),
  })
  .strict();
export type AuctionMarket = z.infer<typeof auctionMarketSchema>;
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
    reportTimeZone: reportTimeZoneSchema.default("UTC"),
    guildRankNames: guildRankNamesSchema,
    auctionMarket: auctionMarketSchema.optional(),
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
export const foreverBuildSchema = z.string().regex(/^1\.60\.\d{1,3}\.\d{4,6}$/);
export const spellIdSchema = z.number().int().positive().max(2_147_483_647);
export const itemIdSchema = z.number().int().positive().max(2_147_483_647);
export const recipeMappingSchema = z
  .object({
    build: foreverBuildSchema,
    source: z.literal("wago.tools/SkillLineAbility"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    fetchedAt: z.iso.datetime(),
    spells: z
      .record(z.string().regex(/^[1-9]\d{0,9}$/), spellIdSchema)
      .refine((entries) => Object.keys(entries).length <= 20_000),
  })
  .strict();
export type RecipeMapping = z.infer<typeof recipeMappingSchema>;
const recipeItemSchema = z
  .object({
    id: itemIdSchema,
    name: z.string().trim().min(1).max(200),
  })
  .strict();
export const recipeDetailsSchema = z
  .object({
    id: recipeItemSchema.shape.id,
    name: recipeItemSchema.shape.name,
    output: recipeItemSchema.optional(),
    quantity: z
      .object({
        min: z.number().int().positive().max(1_000_000),
        max: z.number().int().positive().max(1_000_000),
      })
      .strict()
      .refine((q) => q.min <= q.max)
      .optional(),
    // Omitted is unknown; [] is explicitly no reagents reported.
    reagents: z
      .array(
        z
          .object({
            item: recipeItemSchema,
            quantity: z.number().int().positive().max(1_000_000),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();
export type RecipeDetails = z.infer<typeof recipeDetailsSchema>;
const recipeDetailEntrySchema = z
  .object({
    status: z.enum(["ok", "unavailable", "error"]),
    attemptedAt: z.iso.datetime(),
    fetchedAt: z.iso.datetime().nullable(),
    build: foreverBuildSchema.optional(),
    data: recipeDetailsSchema.optional(),
  })
  .strict()
  .refine(
    (entry) =>
      entry.status !== "ok" ||
      (entry.data !== undefined && entry.fetchedAt !== null),
  );
export type RecipeDetailEntry = z.infer<typeof recipeDetailEntrySchema>;
const recipeDetailsIndexSchema = z
  .record(z.string().regex(/^[1-9]\d{0,9}$/), recipeDetailEntrySchema)
  .refine(
    (entries) =>
      Object.keys(entries).length <= 20_000 &&
      Object.entries(entries).every(
        ([id, entry]) => !entry.data || String(entry.data.id) === id,
      ),
  );
// Vendor sell price per item in copper, from the static Forever item API.
// Omitted is unknown; 0 means Blizzard reports no vendor sell price.
export const itemVendorSchema = z
  .object({
    id: itemIdSchema,
    sellCopper: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .strict();
export type ItemVendor = z.infer<typeof itemVendorSchema>;
const itemVendorEntrySchema = z
  .object({
    status: z.enum(["ok", "unavailable", "error"]),
    attemptedAt: z.iso.datetime(),
    fetchedAt: z.iso.datetime().nullable(),
    data: itemVendorSchema.optional(),
  })
  .strict()
  .refine(
    (entry) =>
      entry.status !== "ok" ||
      (entry.data !== undefined && entry.fetchedAt !== null),
  );
export type ItemVendorEntry = z.infer<typeof itemVendorEntrySchema>;
const itemVendorIndexSchema = z
  .record(z.string().regex(/^[1-9]\d{0,9}$/), itemVendorEntrySchema)
  .refine(
    (entries) =>
      Object.keys(entries).length <= 20_000 &&
      Object.entries(entries).every(
        ([id, entry]) => !entry.data || String(entry.data.id) === id,
      ),
  );
export const auctionBookSchema = z
  .object({
    auctionsUpdatedAt: z.iso.datetime().nullable(),
    commoditiesUpdatedAt: z.iso.datetime().nullable(),
    items: z
      .record(
        z.string().regex(/^[1-9]\d{0,9}$/),
        z
          .object({
            unitCopper: z.number().positive().max(Number.MAX_SAFE_INTEGER),
            quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      )
      .refine((items) => Object.keys(items).length <= 50_000),
  })
  .strict();
export type AuctionBook = z.infer<typeof auctionBookSchema>;
const auctionPricesSchema = z
  .object({
    market: auctionMarketSchema,
    status: z.enum(["ok", "unavailable", "error"]),
    attemptedAt: z.iso.datetime(),
    fetchedAt: z.iso.datetime().nullable(),
    data: auctionBookSchema.optional(),
  })
  .strict()
  .refine(
    (entry) =>
      entry.status !== "ok" ||
      (entry.data !== undefined && entry.fetchedAt !== null),
  );
export const snapshotSchema = z
  .object({
    version: z.literal(1),
    region: regionSchema,
    generatedAt: z.iso.datetime(),
    guild: z.string().nullable(),
    reportTimeZone: reportTimeZoneSchema.default("UTC"),
    guildRankNames: guildRankNamesSchema,
    recipeMapping: recipeMappingSchema.optional(),
    recipeDetails: recipeDetailsIndexSchema.optional(),
    itemVendor: itemVendorIndexSchema.optional(),
    auctionMarket: auctionMarketSchema.optional(),
    auctionPrices: auctionPricesSchema.optional(),
    rows: z.array(rowSchema).max(2_000),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (
      snapshot.auctionPrices &&
      JSON.stringify(snapshot.auctionPrices.market) !==
        JSON.stringify(snapshot.auctionMarket)
    )
      ctx.addIssue({
        code: "custom",
        path: ["auctionPrices"],
        message: "Auction prices belong to a different market",
      });
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
    reportTimeZone: config.reportTimeZone,
    guildRankNames: config.guildRankNames,
    ...(config.auctionMarket ? { auctionMarket: config.auctionMarket } : {}),
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
