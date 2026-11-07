import { isFatalApiError } from "./blizzard.ts";
import { ApiError, mapConcurrent, SafeError } from "./http.ts";
import {
  type Character,
  characterSchema,
  discordFor,
  type RosterConfig,
  type RosterRow,
  type Snapshot,
  sortRows,
} from "./model.ts";

export interface RosterSource {
  guild(slug: string): Promise<Character[]>;
  profile(slug: string): Promise<Partial<Character>>;
  professions(slug: string): Promise<Pick<Character, "primary" | "secondary">>;
  talents(slug: string): Promise<Pick<Character, "talents">>;
}

export async function refreshRoster(
  config: RosterConfig,
  map: Record<string, string>,
  source: RosterSource,
  now = new Date(),
  previous?: Snapshot,
): Promise<Snapshot> {
  if (
    previous &&
    (previous.region !== config.region ||
      previous.guild !== (config.guild ?? null))
  )
    throw new SafeError(
      "Previous snapshot belongs to a different guild or region. Choose a new output directory.",
    );
  const prior = new Map(
    previous?.rows.map((r) => [
      r.character.slug.toLocaleLowerCase("en-US"),
      r.character,
    ]),
  );
  const priorRows = new Map(
    previous?.rows.map((r) => [r.character.slug.toLocaleLowerCase("en-US"), r]),
  );
  const characters = new Map<string, Character>();
  // A guild roster failure aborts the run; never silently replace it with an empty roster.
  for (const c of config.guild ? await source.guild(config.guild) : []) {
    const old = prior.get(c.slug.toLocaleLowerCase("en-US"));
    characters.set(
      c.slug.toLocaleLowerCase("en-US"),
      old
        ? {
            ...old,
            name: c.name,
            ...(c.level === undefined ? {} : { level: c.level }),
            ...(c.guildRank === undefined ? {} : { guildRank: c.guildRank }),
          }
        : c,
    );
  }
  for (const c of config.characters) {
    const key = c.slug.toLocaleLowerCase("en-US");
    characters.set(
      key,
      characterSchema.parse({
        ...prior.get(key),
        ...characters.get(key),
        ...c,
      }),
    );
  }
  if (characters.size > 2_000)
    throw new SafeError("Combined roster exceeds 2,000 characters.");
  const fetchedAt = now.toISOString();
  const rows = await mapConcurrent(
    [...characters.values()],
    4,
    async (original): Promise<RosterRow> => {
      let character = original;
      const row: RosterRow = {
        character,
        discord: discordFor(map, config.region, original.slug, original.id),
        profileStatus: "ok",
        professionStatus: "ok",
        talentStatus: "ok",
        fetchedAt,
        profileFetchedAt:
          priorRows.get(original.slug.toLocaleLowerCase("en-US"))
            ?.profileFetchedAt ?? null,
        professionFetchedAt:
          priorRows.get(original.slug.toLocaleLowerCase("en-US"))
            ?.professionFetchedAt ?? null,
        talentFetchedAt:
          priorRows.get(original.slug.toLocaleLowerCase("en-US"))
            ?.talentFetchedAt ?? null,
        issue: "",
      };
      for (const component of ["profile", "professions", "talents"] as const) {
        try {
          const update = await source[component](original.slug);
          character = characterSchema.parse({ ...character, ...update });
          if (component === "profile") row.profileFetchedAt = fetchedAt;
          else if (component === "professions")
            row.professionFetchedAt = fetchedAt;
          else row.talentFetchedAt = fetchedAt;
        } catch (error) {
          if (isFatalApiError(error)) throw error;
          const status =
            error instanceof ApiError && error.status === 404
              ? "unavailable"
              : "error";
          if (component === "profile") row.profileStatus = status;
          else if (component === "professions") row.professionStatus = status;
          else row.talentStatus = status;
          const detail =
            status === "unavailable"
              ? "HTTP 404; profile may be unpublished, below level 10, or temporarily unavailable"
              : "request or response validation failed";
          row.issue += `${component}: ${detail}; retained supplied values. `;
        }
      }
      row.character = character;
      row.discord = discordFor(
        map,
        config.region,
        character.slug,
        character.id,
      );
      return row;
    },
  );
  sortRows(rows);
  return {
    version: 1,
    region: config.region,
    guild: config.guild ?? null,
    generatedAt: fetchedAt,
    rows,
  };
}
