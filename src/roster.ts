import { isFatalApiError } from "./blizzard.ts";
import { ApiError, mapConcurrent, SafeError } from "./http.ts";
import {
  type Character,
  characterIdentity,
  characterSchema,
  discordFor,
  duplicateCharacterIndices,
  hasRetainedRecipes,
  type Profession,
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

class IdentityConflictError extends SafeError {}

// Values each enrichment endpoint owns. When its request fails, values from
// earlier refreshes are cleared rather than shown as if current; only values
// supplied explicitly in the private config survive. Identity, class, level,
// rank, ruleset, faction and race also come from discovery/config and stay.
const componentFields = {
  profile: [
    "equippedItemLevel",
    "averageItemLevel",
    "achievementPoints",
    "experience",
    "lastLoginAt",
  ],
  professions: ["primary", "secondary"],
  talents: ["talents"],
} as const satisfies Record<
  keyof Omit<RosterSource, "guild">,
  readonly (keyof Character)[]
>;

function clearComponent(
  character: Character,
  component: keyof typeof componentFields,
  supplied: object | undefined,
): { character: Character; kept: boolean } {
  const cleared: Record<string, unknown> = { ...character };
  let kept = false;
  for (const field of componentFields[component])
    if (supplied && Object.hasOwn(supplied, field)) kept = true;
    else delete cleared[field];
  return { character: characterSchema.parse(cleared), kept };
}

function refreshRecipeKnowledge(
  current: Profession[],
  previous: Profession[],
  fetchedAt: string,
  priorFetchedAt: string | null,
): Profession[] {
  const key = (p: Profession) =>
    JSON.stringify([
      p.name.toLocaleLowerCase("en-US"),
      (p.tier ?? "").toLocaleLowerCase("en-US"),
    ]);
  return current.map((profession) => {
    if (profession.recipes !== undefined)
      return {
        ...profession,
        recipesRetained: false,
        recipesFetchedAt: fetchedAt,
      };
    const matches = previous.filter(
      (p) => key(p) === key(profession) && p.recipes !== undefined,
    );
    if (matches.length > 1)
      throw new SafeError(
        "Ambiguous recipe history for a profession tier; retained prior profession data.",
      );
    const old = matches[0];
    return old
      ? {
          ...profession,
          recipes: old.recipes,
          recipesRetained: true,
          // null is deliberately preserved: a manual baseline has no success time.
          recipesFetchedAt:
            old.recipesFetchedAt === undefined
              ? priorFetchedAt
              : old.recipesFetchedAt,
        }
      : profession;
  });
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
  if (
    previous &&
    duplicateCharacterIndices(previous.rows.map((r) => r.character)).length
  )
    throw new SafeError(
      "Previous snapshot contains duplicate character identities.",
    );
  const priorRows = new Map(
    previous?.rows.map((r) => [characterIdentity(r.character), r]),
  );
  const priorSlugs = new Map(
    previous?.rows.map((r) => [r.character.slug.toLocaleLowerCase("en-US"), r]),
  );
  const priorFor = (
    character: Pick<Character, "slug" | "id">,
  ): RosterRow | undefined => {
    const stable = character.id
      ? priorRows.get(characterIdentity(character))
      : undefined;
    if (stable) return stable;
    const bySlug = priorSlugs.get(character.slug.toLocaleLowerCase("en-US"));
    // Slug fallback is safe only when at least one side has no stable ID.
    return bySlug && (!character.id || !bySlug.character.id)
      ? bySlug
      : undefined;
  };
  const characters = new Map<string, Character>();
  // The config entry actually merged into each roster key, so clearing honours
  // exactly that entry's supplied fields (never a stale slug match).
  const overrides = new Map<string, RosterConfig["characters"][number]>();
  // A guild roster failure aborts the run; never silently replace it with an empty roster.
  const members = config.guild ? await source.guild(config.guild) : [];
  if (duplicateCharacterIndices(members).length)
    throw new SafeError(
      "Guild roster contains duplicate character identities.",
    );
  const memberIds = new Map(
    members
      .filter((c) => c.id)
      .map((c) => [c.id, c.slug.toLocaleLowerCase("en-US")]),
  );
  for (const c of members) {
    const old = priorFor(c)?.character;
    characters.set(
      c.slug.toLocaleLowerCase("en-US"),
      old
        ? {
            ...old,
            slug: c.slug,
            name: c.name,
            ...(c.id === undefined ? {} : { id: c.id }),
            ...(c.level === undefined ? {} : { level: c.level }),
            ...(c.class ? { class: c.class } : {}),
            ...(c.guildRank === undefined ? {} : { guildRank: c.guildRank }),
          }
        : c,
    );
  }
  for (const c of config.characters) {
    const key =
      (c.id ? memberIds.get(c.id) : undefined) ??
      c.slug.toLocaleLowerCase("en-US");
    const member = characters.get(key);
    if (member?.id && c.id && member.id !== c.id)
      throw new SafeError(
        "Explicit character ID conflicts with guild discovery. Reconcile the private config before refreshing.",
      );
    overrides.set(key, c);
    characters.set(
      key,
      characterSchema.parse({
        // Guild discovery has already selected a safe baseline using its ID.
        // A config entry without an ID must not reopen slug-based history.
        ...(member ?? priorFor(c)?.character),
        ...c,
        slug: member?.slug ?? c.slug,
      }),
    );
  }
  if (characters.size > 2_000)
    throw new SafeError("Combined roster exceeds 2,000 characters.");
  if (duplicateCharacterIndices([...characters.values()]).length)
    throw new SafeError(
      "Combined roster contains duplicate character identities.",
    );
  const fetchedAt = now.toISOString();
  const rows = await mapConcurrent(
    [...characters.entries()],
    4,
    async ([key, original]): Promise<RosterRow> => {
      let character = original;
      const supplied = overrides.get(key);
      const prior = priorFor(original);
      const row: RosterRow = {
        character,
        discord: discordFor(map, config.region, original.slug, original.id),
        profileStatus: "ok",
        professionStatus: "ok",
        talentStatus: "ok",
        fetchedAt,
        profileFetchedAt: prior?.profileFetchedAt ?? null,
        professionFetchedAt: prior?.professionFetchedAt ?? null,
        talentFetchedAt: prior?.talentFetchedAt ?? null,
        issue: "",
      };
      for (const component of ["profile", "professions", "talents"] as const) {
        try {
          const response: Partial<Character> = await source[component](
            original.slug,
          );
          const update =
            component === "professions"
              ? {
                  ...response,
                  primary: refreshRecipeKnowledge(
                    response.primary ?? [],
                    character.primary,
                    fetchedAt,
                    row.professionFetchedAt,
                  ),
                  secondary: refreshRecipeKnowledge(
                    response.secondary ?? [],
                    character.secondary,
                    fetchedAt,
                    row.professionFetchedAt,
                  ),
                }
              : response;
          if (
            "id" in update &&
            update.id &&
            character.id &&
            update.id !== character.id
          )
            throw new IdentityConflictError(
              "Character ID changed during enrichment. Refresh stopped to prevent mixing identities.",
            );
          character = characterSchema.parse({ ...character, ...update });
          if (component === "profile") row.profileFetchedAt = fetchedAt;
          else if (component === "professions") {
            row.professionFetchedAt = fetchedAt;
            if (hasRetainedRecipes(character))
              row.issue +=
                "professions: recipe lists omitted; retained prior tier knowledge with its original success time. ";
          } else row.talentFetchedAt = fetchedAt;
        } catch (error) {
          if (error instanceof IdentityConflictError || isFatalApiError(error))
            throw error;
          const status =
            error instanceof ApiError && error.status === 404
              ? "unavailable"
              : "error";
          if (component === "profile") row.profileStatus = status;
          else if (component === "professions") row.professionStatus = status;
          else row.talentStatus = status;
          const cleared = clearComponent(character, component, supplied);
          character = cleared.character;
          const detail =
            status === "unavailable"
              ? "HTTP 404; profile may be unpublished, below level 10, or temporarily unavailable"
              : "request or response validation failed";
          row.issue += `${component}: ${detail}; cleared values from earlier refreshes${cleared.kept ? " (configured values kept)" : ""}. `;
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
  if (duplicateCharacterIndices(rows.map((row) => row.character)).length)
    throw new SafeError(
      "Enriched roster contains duplicate character identities.",
    );
  sortRows(rows);
  return {
    version: 1,
    region: config.region,
    guild: config.guild ?? null,
    reportTimeZone: config.reportTimeZone,
    guildRankNames: config.guildRankNames,
    ...(config.auctionMarket ? { auctionMarket: config.auctionMarket } : {}),
    generatedAt: fetchedAt,
    rows,
  };
}
