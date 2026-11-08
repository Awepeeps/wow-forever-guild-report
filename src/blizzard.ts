import { z } from "zod";
import { ApiError, HttpClient, SafeError } from "./http.ts";
import {
  type AuctionBook,
  type AuctionMarket,
  auctionBookSchema,
  auctionMarketSchema,
  type Character,
  characterSchema,
  itemIdSchema,
  type Profession,
  type RecipeDetails,
  type RosterConfig,
  recipeDetailsSchema,
  recipeSchema,
  slugSchema,
} from "./model.ts";

const reference = z.object({ name: z.string().min(1) });
const profileSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().min(1),
  surname: z.string().optional(),
  ruleset: reference.optional(),
  character_class: reference.optional(),
  faction: reference.optional(),
  race: reference.optional(),
  level: z.number().int().positive().optional(),
  equipped_item_level: z.number().int().nonnegative().optional(),
  average_item_level: z.number().int().nonnegative().optional(),
  last_login_timestamp: z
    .number()
    .int()
    .nonnegative()
    .max(253_402_300_799_999)
    .optional(),
  achievement_points: z.number().int().nonnegative().optional(),
  experience: z.number().int().nonnegative().optional(),
});
const tierSchema = z.object({
  tier: reference.optional(),
  skill_points: z.number().int().nonnegative(),
  max_skill_points: z.number().int().nonnegative(),
  known_recipes: z.array(recipeSchema.strip()).max(10_000).optional(),
});
const apiProfession = z.object({
  profession: reference,
  tiers: z.array(tierSchema).optional(),
  skill_points: z.number().int().nonnegative().optional(),
  max_skill_points: z.number().int().nonnegative().optional(),
});
const professionsSchema = z.object({
  character: z.object({ slug: slugSchema }),
  primaries: z.array(apiProfession).default([]),
  secondaries: z.array(apiProfession).default([]),
});
const guildSchema = z.object({
  members: z
    .array(
      z.object({
        rank: z.number().int().nonnegative(),
        character: z.object({
          id: z.number().int().positive().optional(),
          name: z.string(),
          surname: z.string().optional(),
          slug: slugSchema.optional(),
          level: z.number().int().positive().optional(),
          playable_class: z
            .object({
              id: z.number().int().positive(),
              name: z.string().min(1).optional(),
            })
            .optional(),
        }),
      }),
    )
    .max(2_000),
});
const classIndexSchema = z.object({
  classes: z
    .array(
      z.object({ id: z.number().int().positive(), name: z.string().min(1) }),
    )
    .max(100),
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});
const positiveQuantity = z.number().int().positive().max(1_000_000);
const recipeItem = z.object({
  id: z.number().int().positive().max(2_147_483_647),
  name: z.string().trim().min(1).max(200),
});
const recipeDetailSchema = z.object({
  id: recipeItem.shape.id,
  name: recipeItem.shape.name,
  crafted_item: recipeItem.optional(),
  crafted_quantity: z
    .union([
      z.object({ value: positiveQuantity }),
      z
        .object({ minimum: positiveQuantity, maximum: positiveQuantity })
        .refine((q) => q.minimum <= q.maximum),
    ])
    .optional(),
  reagents: z
    .array(z.object({ reagent: recipeItem, quantity: positiveQuantity }))
    .max(100)
    .optional(),
});
const talentsSchema = z.object({
  specialization_groups: z
    .array(
      z.object({
        is_active: z.boolean(),
        specializations: z
          .array(
            z.object({
              specialization: reference,
              specialization_name: z.string().optional(),
              spent_points: z.number().int().nonnegative(),
            }),
          )
          .default([]),
      }),
    )
    .max(10),
});
const auctionQuantity = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const auctionMoney = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const auctionListing = z.object({
  id: auctionQuantity,
  item: z.object({ id: itemIdSchema }),
  quantity: auctionQuantity,
  buyout: auctionMoney.optional(),
});
const commodityListing = auctionListing
  .omit({ buyout: true })
  .extend({ unit_price: auctionMoney });

function modifiedAt(header: string | null): string | null {
  if (header === null) return null;
  const time = Date.parse(header);
  if (!Number.isFinite(time))
    throw new SafeError("Blizzard auction snapshot time is invalid.");
  return new Date(time).toISOString();
}

function parseApi<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success)
    throw new SafeError(
      `Blizzard ${label} response has an unsupported shape. No data was inferred.`,
    );
  return result.data;
}

function normalizeProfessions(
  items: z.infer<typeof apiProfession>[],
): Profession[] {
  return items.flatMap((p) => {
    if (p.tiers?.length)
      return p.tiers.map((t) => ({
        name: p.profession.name,
        skill: t.skill_points,
        max: t.max_skill_points,
        ...(t.tier ? { tier: t.tier.name } : {}),
        ...(t.known_recipes === undefined ? {} : { recipes: t.known_recipes }),
      }));
    return [
      {
        name: p.profession.name,
        ...(p.skill_points !== undefined ? { skill: p.skill_points } : {}),
        ...(p.max_skill_points !== undefined
          ? { max: p.max_skill_points }
          : {}),
      },
    ];
  });
}

class BlizzardAuthError extends SafeError {}

export class BlizzardClient {
  private token: { value: string; expires: number } | undefined;
  private pendingToken: Promise<string> | undefined;
  constructor(
    private readonly config: Pick<RosterConfig, "region" | "locale">,
    private readonly credentials: { clientId: string; clientSecret: string },
    private readonly http = new HttpClient(),
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000)
      return this.token.value;
    if (this.pendingToken) return this.pendingToken;
    this.pendingToken = (async () => {
      const data = await this.http.json(
        "Blizzard OAuth",
        "https://oauth.battle.net/token",
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: "grant_type=client_credentials",
        },
      );
      const token = parseApi(tokenSchema, data, "OAuth");
      this.token = {
        value: token.access_token,
        expires: Date.now() + token.expires_in * 1_000,
      };
      return token.access_token;
    })().catch(() => {
      throw new BlizzardAuthError(
        "Blizzard OAuth authentication failed. Check credentials and connectivity; no exports were written.",
      );
    });
    try {
      return await this.pendingToken;
    } finally {
      this.pendingToken = undefined;
    }
  }

  private async get(
    path: string,
    namespace: "profile" | "static" | "dynamic" = "profile",
  ): Promise<unknown> {
    return (await this.getResponse(path, namespace)).data;
  }

  private async getResponse(
    path: string,
    namespace: "profile" | "static" | "dynamic",
  ): Promise<{ data: unknown; lastModified: string | null }> {
    const url = new URL(
      `https://${this.config.region}.api.blizzard.com${path}`,
    );
    url.searchParams.set(
      "namespace",
      `${namespace}-forever-${this.config.region}`,
    );
    url.searchParams.set("locale", this.config.locale);
    return this.http.jsonWithMetadata("Blizzard API", url, {
      headers: { Authorization: `Bearer ${await this.accessToken()}` },
    });
  }

  async auctionPrices(input: AuctionMarket): Promise<AuctionBook> {
    const market = auctionMarketSchema.parse(input);
    const prefix = `/data/wow/ruleset/${market.rulesetId}`;
    const ruleset = parseApi(
      z.object({ id: z.number().int(), name: z.string() }),
      await this.get(prefix, "dynamic"),
      "auction ruleset",
    );
    if (ruleset.id !== market.rulesetId || ruleset.name !== market.rulesetName)
      throw new SafeError(
        "Blizzard auction ruleset does not match the verified market.",
      );
    const index = parseApi(
      z.object({
        auctions: z
          .array(z.object({ id: z.number().int(), name: z.string() }))
          .max(100),
      }),
      await this.get(`${prefix}/auctions/`, "dynamic"),
      "auction index",
    );
    const expectedName = `${market.faction} Auction House`;
    if (
      !index.auctions.some(
        (h) => h.id === market.houseId && h.name === expectedName,
      )
    )
      throw new SafeError(
        "Blizzard auction house does not match the verified market.",
      );
    const base = `${prefix}/auctions/${market.houseId}`;
    const [regularResponse, commodityResponse] = await Promise.all([
      this.getResponse(base, "dynamic"),
      this.getResponse(`${base}/commodities`, "dynamic"),
    ]);
    const regular = parseApi(
      z.object({
        id: z.number().int(),
        name: z.string(),
        auctions: z.array(auctionListing).max(500_000).optional(),
      }),
      regularResponse.data,
      "auction listings",
    );
    const commodities = parseApi(
      z.object({ auctions: z.array(commodityListing).max(500_000).optional() }),
      commodityResponse.data,
      "commodity listings",
    );
    if (regular.id !== market.houseId || regular.name !== expectedName)
      throw new SafeError(
        "Blizzard auction listings belong to a different market.",
      );
    const items: AuctionBook["items"] = {};
    const ids = new Set<number>();
    function add(
      id: number,
      itemId: number,
      quantity: number,
      unitCopper: number | undefined,
    ) {
      if (ids.has(id))
        throw new SafeError(
          "Blizzard auction data contains duplicate listing identities.",
        );
      ids.add(id);
      if (unitCopper === undefined || unitCopper <= 0) return;
      const key = String(itemId),
        old = items[key];
      items[key] = {
        unitCopper: Math.min(old?.unitCopper ?? unitCopper, unitCopper),
        quantity: (old?.quantity ?? 0) + quantity,
      };
    }
    for (const a of regular.auctions ?? [])
      add(
        a.id,
        a.item.id,
        a.quantity,
        a.buyout === undefined ? undefined : a.buyout / a.quantity,
      );
    for (const a of commodities.auctions ?? [])
      add(a.id, a.item.id, a.quantity, a.unit_price);
    return parseApi(
      auctionBookSchema,
      {
        auctionsUpdatedAt: modifiedAt(regularResponse.lastModified),
        commoditiesUpdatedAt: modifiedAt(commodityResponse.lastModified),
        items,
      },
      "normalized auction prices",
    );
  }

  async guild(slug: string): Promise<Character[]> {
    const data = parseApi(
      guildSchema,
      await this.get(`/data/wow/guild/${encodeURIComponent(slug)}/roster`),
      "guild roster",
    );
    const classNames = new Map<number, string>();
    if (
      data.members.some(
        ({ character }) =>
          character.playable_class && !character.playable_class.name,
      )
    ) {
      try {
        const index = parseApi(
          classIndexSchema,
          await this.get("/data/wow/playable-class/index", "static"),
          "class index",
        );
        for (const entry of index.classes) classNames.set(entry.id, entry.name);
      } catch (error) {
        // Optional roster metadata must not make valid guild discovery fail.
        // Profile status remains independent, including unavailable characters.
        if (isFatalApiError(error)) throw error;
      }
    }
    return data.members.map(({ character: c, rank }) => {
      const fullName = [c.name, c.surname].filter(Boolean).join(" ");
      if (!c.slug)
        throw new SafeError(
          "Blizzard guild member is missing its Forever slug. Guild refresh stopped; for an explicit-only roster, remove guild from the config.",
        );
      return parseApi(
        characterSchema,
        {
          slug: c.slug,
          name: fullName,
          ...(c.id === undefined ? {} : { id: String(c.id) }),
          guildRank: rank,
          class:
            c.playable_class?.name ??
            (c.playable_class
              ? classNames.get(c.playable_class.id)
              : undefined) ??
            "",
          ...(c.level === undefined ? {} : { level: c.level }),
        },
        "guild member",
      );
    });
  }

  async profile(slug: string): Promise<Partial<Character>> {
    const p = parseApi(
      profileSchema,
      await this.get(`/profile/wow/character/${encodeURIComponent(slug)}`),
      "character profile",
    );
    return {
      name: [p.name, p.surname].filter(Boolean).join(" "),
      ...(p.id === undefined ? {} : { id: String(p.id) }),
      ...(p.ruleset ? { ruleset: p.ruleset.name } : {}),
      ...(p.character_class ? { class: p.character_class.name } : {}),
      ...(p.faction ? { faction: p.faction.name } : {}),
      ...(p.race ? { race: p.race.name } : {}),
      ...(p.level ? { level: p.level } : {}),
      equippedItemLevel: p.equipped_item_level,
      averageItemLevel: p.average_item_level,
      achievementPoints: p.achievement_points,
      experience: p.experience,
      lastLoginAt: p.last_login_timestamp
        ? new Date(p.last_login_timestamp).toISOString()
        : undefined,
    };
  }

  async recipe(id: number): Promise<RecipeDetails> {
    const recipeId = parseApi(recipeItem.shape.id, id, "recipe ID");
    const data = parseApi(
      recipeDetailSchema,
      await this.get(`/data/wow/recipe/${recipeId}`, "static"),
      "recipe details",
    );
    if (data.id !== recipeId)
      throw new SafeError(
        "Blizzard recipe identity did not match the request.",
      );
    const quantity = data.crafted_quantity;
    return parseApi(
      recipeDetailsSchema,
      {
        id: data.id,
        name: data.name,
        ...(data.crafted_item ? { output: data.crafted_item } : {}),
        ...(quantity
          ? {
              quantity:
                "value" in quantity
                  ? { min: quantity.value, max: quantity.value }
                  : { min: quantity.minimum, max: quantity.maximum },
            }
          : {}),
        ...(data.reagents === undefined
          ? {}
          : {
              reagents: data.reagents.map((r) => ({
                item: r.reagent,
                quantity: r.quantity,
              })),
            }),
      },
      "normalized recipe details",
    );
  }

  async professions(
    slug: string,
  ): Promise<Pick<Character, "primary" | "secondary">> {
    const data = parseApi(
      professionsSchema,
      await this.get(
        `/profile/wow/character/${encodeURIComponent(slug)}/professions`,
      ),
      "professions",
    );
    return {
      primary: normalizeProfessions(data.primaries),
      secondary: normalizeProfessions(data.secondaries),
    };
  }

  async talents(slug: string): Promise<Pick<Character, "talents">> {
    const data = parseApi(
      talentsSchema,
      await this.get(
        `/profile/wow/character/${encodeURIComponent(slug)}/specializations`,
      ),
      "talents",
    );
    const active = data.specialization_groups.filter((g) => g.is_active);
    if (active.length === 0)
      throw new SafeError(
        "Blizzard talent response has no active talent group.",
      );
    return {
      talents: active.flatMap((g, i) =>
        g.specializations.map((s) => ({
          tree: s.specialization_name || s.specialization.name,
          points: s.spent_points,
          ...(active.length > 1 ? { group: i + 1 } : {}),
        })),
      ),
    };
  }
}

export function isFatalApiError(error: unknown): boolean {
  return (
    error instanceof BlizzardAuthError ||
    (error instanceof ApiError &&
      (error.status === 401 || error.service === "Blizzard OAuth"))
  );
}
