import { z } from "zod";
import { ApiError, HttpClient, SafeError } from "./http.ts";
import {
  type Character,
  characterSchema,
  type Profession,
  type RosterConfig,
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
});
const tierSchema = z.object({
  tier: reference.optional(),
  skill_points: z.number().int().nonnegative(),
  max_skill_points: z.number().int().nonnegative(),
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
        }),
      }),
    )
    .max(2_000),
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
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

  private async get(path: string): Promise<unknown> {
    const url = new URL(
      `https://${this.config.region}.api.blizzard.com${path}`,
    );
    url.searchParams.set("namespace", `profile-forever-${this.config.region}`);
    url.searchParams.set("locale", this.config.locale);
    return this.http.json("Blizzard API", url, {
      headers: { Authorization: `Bearer ${await this.accessToken()}` },
    });
  }

  async guild(slug: string): Promise<Character[]> {
    const data = parseApi(
      guildSchema,
      await this.get(`/data/wow/guild/${encodeURIComponent(slug)}/roster`),
      "guild roster",
    );
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
    };
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
