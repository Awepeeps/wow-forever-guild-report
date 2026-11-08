import { describe, expect, test } from "bun:test";
import { ApiError } from "../src/http.ts";
import { characterSchema, configSchema, snapshotSchema } from "../src/model.ts";
import { refreshRoster } from "../src/roster.ts";
import { buildTables } from "../src/workbook.ts";
import { config, now, snapshot, source } from "./helpers.ts";

test("omitted recipe lists retain the same tier's knowledge with its own timestamp; explicit empty lists and different tiers do not", async () => {
  const input = configSchema.parse({
    ...config,
    characters: [{ slug: "example-priest", name: "Example Priest" }],
  });
  const first = await refreshRoster(
    input,
    {},
    source({
      professions: async () => ({
        primary: [
          {
            name: "Alchemy",
            tier: "First",
            skill: 50,
            max: 75,
            recipes: [{ id: 42, name: "Invented Tonic" }],
          },
        ],
        secondary: [],
      }),
    }),
    now,
  );
  const later = new Date("2026-11-08T16:00:00.000Z");
  const current = await refreshRoster(
    input,
    {},
    source({
      professions: async () => ({
        primary: [{ name: "Alchemy", tier: "First", skill: 51, max: 75 }],
        secondary: [],
      }),
    }),
    later,
    first,
  );
  const p = current.rows[0]?.character.primary[0];
  expect(p).toMatchObject({
    skill: 51,
    recipes: [{ id: 42, name: "Invented Tonic" }],
    recipesRetained: true,
    recipesFetchedAt: now.toISOString(),
  });
  expect(current.rows[0]?.professionStatus).toBe("ok");
  expect(current.rows[0]?.professionFetchedAt).toBe(later.toISOString());
  const tables = buildTables(current);
  expect(tables[1]?.rows[1]).toContain("Skills current; recipes retained");
  expect(tables[0]?.rows[1]).toContain("Incomplete");
  expect(tables[2]?.rows[1]?.[2]).toContain(
    `[retained; last success: ${now.toISOString()}]`,
  );
  expect(tables[2]?.rows[1]?.[3]).toBe("Includes retained data");
  for (const primary of [
    [{ name: "Alchemy", tier: "First", skill: 51, max: 75, recipes: [] }],
    [{ name: "Alchemy", tier: "Second", skill: 51, max: 75 }],
    [{ name: "Cooking", tier: "First", skill: 51, max: 75 }],
    [],
  ]) {
    const next = await refreshRoster(
      input,
      {},
      source({ professions: async () => ({ primary, secondary: [] }) }),
      later,
      first,
    );
    expect(buildTables(next)[2]?.rows).toHaveLength(1);
    expect(next.rows[0]?.character.primary[0]?.recipesRetained ?? false).toBe(
      false,
    );
  }
  const unavailable = async (): Promise<never> => {
    throw new ApiError("Blizzard API", 404);
  };
  const failed = await refreshRoster(
    input,
    {},
    source({ professions: unavailable }),
    new Date("2026-11-09T16:00:00.000Z"),
    current,
  );
  expect(failed.rows[0]?.character.primary[0]?.recipesFetchedAt).toBe(
    now.toISOString(),
  );
  expect(buildTables(failed)[2]?.rows[1]?.[2]).toContain(now.toISOString());
});

test("failed components retain metrics/recipes and their success times, while successful omitted metrics become unknown", async () => {
  const profile = {
    equippedItemLevel: 12,
    averageItemLevel: 15,
    experience: 0,
    achievementPoints: 20,
    lastLoginAt: "2026-11-06T12:00:00.000Z",
  };
  const primary = [
    { name: "Alchemy", recipes: [{ id: 42, name: "Invented Tonic" }] },
  ];
  const input = configSchema.parse({
    ...config,
    characters: [{ slug: "example-priest", name: "Example Priest" }],
  });
  const previous = await refreshRoster(
    input,
    {},
    source({
      profile: async () => profile,
      professions: async () => ({ primary, secondary: [] }),
    }),
    now,
  );
  const unavailable = async (): Promise<never> => {
    throw new ApiError("Blizzard API", 404);
  };
  const later = new Date("2026-11-08T16:00:00.000Z");
  const result = await refreshRoster(
    input,
    {},
    source({ profile: unavailable, professions: unavailable }),
    later,
    previous,
  );
  expect(result.rows[0]?.character).toMatchObject({ ...profile, primary });
  expect(result.rows[0]?.profileFetchedAt).toBe(now.toISOString());
  expect(result.rows[0]?.professionFetchedAt).toBe(now.toISOString());
  const successful = await refreshRoster(
    input,
    {},
    source({
      profile: async () => ({
        equippedItemLevel: undefined,
        averageItemLevel: undefined,
        experience: undefined,
        achievementPoints: undefined,
        lastLoginAt: undefined,
      }),
    }),
    later,
    previous,
  );
  expect(successful.rows[0]?.character.experience).toBeUndefined();
  expect(successful.rows[0]?.character.lastLoginAt).toBeUndefined();
  expect(successful.rows[0]?.profileFetchedAt).toBe(later.toISOString());
});

describe("guild roster refresh", () => {
  test("stable-ID renames retain enrichment and success times for guild and explicit discovery", async () => {
    const priorConfig = configSchema.parse({
      ...config,
      characters: [{ slug: "old-name", name: "Old Name", id: "123" }],
    });
    const prior = await refreshRoster(priorConfig, {}, source(), now);
    const unavailable = async (): Promise<never> => {
      throw new ApiError("Blizzard API", 404);
    };
    for (const guildDiscovery of [true, false]) {
      const current = characterSchema.parse({
        slug: "new-name",
        name: "New Name",
        id: "123",
        guildRank: 3,
      });
      const requests: string[] = [];
      const result = await refreshRoster(
        configSchema.parse({
          ...priorConfig,
          characters: guildDiscovery
            ? []
            : [{ slug: current.slug, name: current.name, id: current.id }],
        }),
        { "us:id:123": "same-person" },
        source({
          guild: async () => (guildDiscovery ? [current] : []),
          profile: async (slug) => {
            requests.push(slug);
            return unavailable();
          },
          professions: unavailable,
          talents: unavailable,
        }),
        new Date(now.getTime() + 60_000),
        prior,
      );
      expect(requests).toEqual(["new-name"]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.character.slug).toBe("new-name");
      expect(result.rows[0]?.character.id).toBe("123");
      expect(result.rows[0]?.character.primary).toEqual(
        prior.rows[0]?.character.primary,
      );
      expect(result.rows[0]?.character.talents).toEqual(
        prior.rows[0]?.character.talents,
      );
      expect(result.rows[0]?.professionFetchedAt).toBe(now.toISOString());
      expect(result.rows[0]?.talentFetchedAt).toBe(now.toISOString());
      expect(result.rows[0]?.discord).toBe("same-person");
    }
  });

  test("a reused slug never inherits the old ID, enrichment, timestamps or ID-based Discord mapping", async () => {
    const oldConfig = configSchema.parse({
      ...config,
      characters: [{ slug: "shared-name", name: "Shared Name", id: "111" }],
    });
    const prior = await refreshRoster(oldConfig, {}, source(), now);
    const unavailable = async (): Promise<never> => {
      throw new ApiError("Blizzard API", 404);
    };
    for (const profileAvailable of [true, false]) {
      for (const discovery of ["guild", "explicit", "guild-with-override"]) {
        const current = characterSchema.parse({
          slug: "shared-name",
          name: "Shared Name",
          id: "999",
        });
        const result = await refreshRoster(
          configSchema.parse({
            ...oldConfig,
            characters:
              discovery === "guild"
                ? []
                : [
                    {
                      slug: current.slug,
                      name: current.name,
                      ...(discovery === "explicit" ? { id: current.id } : {}),
                    },
                  ],
          }),
          { "us:id:111": "old-person" },
          source({
            guild: async () => (discovery === "explicit" ? [] : [current]),
            profile: profileAvailable
              ? async () => ({ id: "999" })
              : unavailable,
            professions: unavailable,
            talents: unavailable,
          }),
          new Date(now.getTime() + 60_000),
          prior,
        );
        expect(result.rows[0]?.character.id).toBe("999");
        expect(result.rows[0]?.character.level).toBeUndefined();
        expect(result.rows[0]?.character.primary).toEqual([]);
        expect(result.rows[0]?.character.talents).toEqual([]);
        expect(result.rows[0]?.professionFetchedAt).toBe(null);
        expect(result.rows[0]?.talentFetchedAt).toBe(null);
        expect(result.rows[0]?.discord).toBe("");
      }
    }
  });

  test("ID upgrade retains a slug-only snapshot, and contradictory profile IDs abort", async () => {
    const current = characterSchema.parse({
      slug: "example-priest",
      name: "Example Priest",
      id: "123",
    });
    const unavailable = async (): Promise<never> => {
      throw new ApiError("Blizzard API", 404);
    };
    const result = await refreshRoster(
      configSchema.parse({ ...config, characters: [] }),
      {},
      source({ guild: async () => [current], professions: unavailable }),
      now,
      snapshot,
    );
    expect(result.rows[0]?.character.primary).toEqual(
      snapshot.rows[0]?.character.primary,
    );
    expect(result.rows[0]?.character.id).toBe("123");
    await expect(
      refreshRoster(
        configSchema.parse({ ...config, characters: [] }),
        {},
        source({
          guild: async () => [current],
          profile: async () => ({ id: "999" }),
        }),
      ),
    ).rejects.toThrow("Character ID changed");
    await expect(
      refreshRoster(
        configSchema.parse({
          ...config,
          characters: [{ ...current, id: "999" }],
        }),
        {},
        source({ guild: async () => [current] }),
      ),
    ).rejects.toThrow("ID conflicts with guild");
  });

  test("duplicate IDs and slugs are rejected at config, snapshot and guild boundaries", async () => {
    const first = characterSchema.parse({
      slug: "first-name",
      name: "First Name",
      id: "123",
    });
    const second = { ...first, slug: "second-name", name: "Second Name" };
    expect(
      configSchema.safeParse({ ...config, characters: [first, second] })
        .success,
    ).toBe(false);
    const row = snapshot.rows[0];
    if (!row) throw new Error("fixture");
    expect(
      snapshotSchema.safeParse({
        ...snapshot,
        rows: [
          { ...row, character: first },
          { ...row, character: second },
        ],
      }).success,
    ).toBe(false);
    await expect(
      refreshRoster(config, {}, source({ guild: async () => [first, second] })),
    ).rejects.toThrow("duplicate character identities");
    await expect(
      refreshRoster(
        config,
        {},
        source({ guild: async () => [first, { ...first, id: "999" }] }),
      ),
    ).rejects.toThrow("duplicate character identities");
  });

  test("minimal explicit overrides retain last-good values when enrichment fails, with or without guild discovery", async () => {
    for (const guild of ["example-guild", undefined]) {
      const initialConfig = configSchema.parse({
        version: 1,
        region: "us",
        ...(guild ? { guild } : {}),
        characters: [{ slug: "example-priest", name: "Example Priest" }],
      });
      const prior = await refreshRoster(initialConfig, {}, source(), now);
      expect(Object.hasOwn(initialConfig.characters[0] ?? {}, "primary")).toBe(
        false,
      );
      const unavailable = async (): Promise<never> => {
        throw new ApiError("Blizzard API", 404);
      };
      const later = new Date(now.getTime() + 60_000);
      const result = await refreshRoster(
        initialConfig,
        {},
        source({
          guild: async () => [
            characterSchema.parse({
              slug: "example-priest",
              name: "Example Priest",
              guildRank: 2,
            }),
          ],
          profile: unavailable,
          professions: unavailable,
          talents: unavailable,
        }),
        later,
        prior,
      );
      expect(result.rows[0]?.character.primary).toEqual(
        prior.rows[0]?.character.primary,
      );
      expect(result.rows[0]?.character.secondary).toEqual(
        prior.rows[0]?.character.secondary,
      );
      expect(result.rows[0]?.character.talents).toEqual(
        prior.rows[0]?.character.talents,
      );
      expect(result.rows[0]?.character.class).toBe("Priest");
      expect(result.rows[0]?.profileFetchedAt).toBe(now.toISOString());
      expect(result.rows[0]?.professionFetchedAt).toBe(now.toISOString());
      expect(result.rows[0]?.talentFetchedAt).toBe(now.toISOString());
      const clear = configSchema.parse({
        ...initialConfig,
        characters: [
          {
            slug: "example-priest",
            name: "Example Priest",
            primary: [],
            secondary: [],
            talents: [],
          },
        ],
      });
      const cleared = await refreshRoster(
        clear,
        {},
        source({ professions: unavailable, talents: unavailable }),
        later,
        prior,
      );
      expect(cleared.rows[0]?.character.primary).toEqual([]);
      expect(cleared.rows[0]?.character.talents).toEqual([]);
    }
  });
  test("discovers members, merges overrides once, maps Discord by region, and includes guild rank and talents", async () => {
    const api = source({
      guild: async () => [
        characterSchema.parse({
          name: "Example Priest",
          slug: "example-priest",
          guildRank: 2,
        }),
        characterSchema.parse({
          name: "Example Mage",
          slug: "example-mage",
          guildRank: 0,
        }),
      ],
    });
    const result = await refreshRoster(
      config,
      { "us:example-mage": "mapped", "eu:example-priest": "wrong" },
      api,
      now,
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.discord).toBe("mapped");
    expect(result.rows[0]?.character.guildRank).toBe(0);
    expect(result.rows[1]?.discord).toBe("");
    expect(result.rows[0]?.character.talents).toEqual([
      { tree: "Shadow Magic", points: 5 },
      { tree: "Discipline", points: 2 },
    ]);
    expect(result.rows[0]?.fetchedAt).toBe(now.toISOString());
    expect(snapshotSchema.safeParse(result).success).toBe(true);
  });
  test("retains supplied values on 404 while updating independent components", async () => {
    const result = await refreshRoster(
      config,
      {},
      source({
        professions: async () => {
          throw new ApiError("Blizzard API", 404);
        },
      }),
      now,
    );
    const row = result.rows[0];
    expect(row?.character.primary[0]?.skill).toBe(50);
    expect(row?.professionStatus).toBe("unavailable");
    expect(row?.profileStatus).toBe("ok");
    expect(row?.character.level).toBe(17);
    expect(row?.issue).toContain("retained");
  });
  test("preserves last-good professions for guild members, removes departed members", async () => {
    const guildConfig = configSchema.parse({
      version: 1,
      region: "us",
      guild: "example-guild",
    });
    const api = source({
      guild: async () => [
        characterSchema.parse({
          slug: "example-priest",
          name: "Example Priest",
          guildRank: 1,
        }),
      ],
      professions: async () => {
        throw new ApiError("Blizzard API", 503);
      },
    });
    const result = await refreshRoster(guildConfig, {}, api, now, snapshot);
    expect(result.rows[0]?.character.primary[0]?.skill).toBe(50);
    expect(result.rows[0]?.character.guildRank).toBe(1);
    expect(result.rows[0]?.professionStatus).toBe("error");
    expect(result.rows[0]?.professionFetchedAt).toBe(null);
    const empty = await refreshRoster(guildConfig, {}, source(), now, snapshot);
    expect(empty.rows).toHaveLength(0);
  });
  test("character 403 retains the affected component while guild 403 and OAuth 403 abort", async () => {
    const forbidden = async (): Promise<never> => {
      throw new ApiError("Blizzard API", 403);
    };
    const result = await refreshRoster(
      config,
      {},
      source({ professions: forbidden }),
      now,
      snapshot,
    );
    expect(result.rows[0]?.character.primary).toEqual(
      snapshot.rows[0]?.character.primary,
    );
    expect(result.rows[0]?.professionStatus).toBe("error");
    expect(result.rows[0]?.profileStatus).toBe("ok");
    expect(result.rows[0]?.talentStatus).toBe("ok");
    await expect(
      refreshRoster(config, {}, source({ guild: forbidden })),
    ).rejects.toThrow("HTTP 403");
    await expect(
      refreshRoster(
        config,
        {},
        source({
          profile: async () => {
            throw new ApiError("Blizzard OAuth", 403);
          },
        }),
      ),
    ).rejects.toThrow("HTTP 403");
  });
  test("guild and auth failures abort rather than publishing a misleading roster", async () => {
    await expect(
      refreshRoster(
        config,
        {},
        source({
          guild: async () => {
            throw new ApiError("Blizzard API", 404);
          },
        }),
      ),
    ).rejects.toThrow("HTTP 404");
    await expect(
      refreshRoster(
        config,
        {},
        source({
          profile: async () => {
            throw new ApiError("Blizzard API", 401);
          },
        }),
      ),
    ).rejects.toThrow("HTTP 401");
    await expect(
      refreshRoster(config, {}, source(), now, { ...snapshot, region: "eu" }),
    ).rejects.toThrow("different guild or region");
  });
  test("rejects duplicate identities and impossible profession levels", () => {
    expect(
      configSchema.safeParse({
        ...config,
        characters: [...config.characters, ...config.characters],
      }).success,
    ).toBe(false);
    expect(
      characterSchema.safeParse({
        slug: "example-priest",
        name: "Example Priest",
        primary: [{ name: "Alchemy", skill: 76, max: 75 }],
      }).success,
    ).toBe(false);
  });
});

test("groups Discord alts, uses deterministic character order, puts unmapped last, and maps stable IDs first", async () => {
  const guildConfig = configSchema.parse({
    version: 1,
    region: "us",
    guild: "example-guild",
  });
  const members = ["zed-alt", "aaron-unmapped", "beta-main", "alpha-alt"].map(
    (slug) =>
      characterSchema.parse({
        slug,
        name: slug,
        ...(slug === "zed-alt" ? { id: "123" } : {}),
      }),
  );
  const api = source({ guild: async () => members, profile: async () => ({}) });
  const result = await refreshRoster(
    guildConfig,
    {
      "us:id:123": "amy",
      "us:zed-alt": "wrong",
      "us:alpha-alt": "amy",
      "us:beta-main": "bob",
    },
    api,
    now,
  );
  expect(result.rows.map((r) => r.character.slug)).toEqual([
    "alpha-alt",
    "zed-alt",
    "beta-main",
    "aaron-unmapped",
  ]);
  const later = new Date(now.getTime() + 60_000);
  const partial = await refreshRoster(
    guildConfig,
    {},
    source({
      guild: async () => members,
      professions: async () => {
        throw new ApiError("Blizzard API", 404);
      },
    }),
    later,
    result,
  );
  expect(partial.rows[0]?.professionFetchedAt).toBe(now.toISOString());
  expect(partial.rows[0]?.fetchedAt).toBe(later.toISOString());
});

test("rank labels validate at config boundaries, survive snapshots, and ranks control stored sort order", async () => {
  for (const key of ["-1", "01", "1000", "1.5", "name"]) {
    expect(
      configSchema.safeParse({ ...config, guildRankNames: { [key]: "Label" } })
        .success,
    ).toBe(false);
  }
  expect(
    configSchema.safeParse({ ...config, guildRankNames: { "0": "   " } })
      .success,
  ).toBe(false);
  expect(
    snapshotSchema.parse({ ...snapshot, guildRankNames: undefined })
      .guildRankNames,
  ).toEqual({});
  const cfg = configSchema.parse({
    ...config,
    guildRankNames: { "0": " Guild Master ", "1": "Officer" },
    characters: [],
  });
  const result = await refreshRoster(
    cfg,
    { "us:leader": "Zebra", "us:officer": "Alice" },
    source({
      guild: async () => [
        characterSchema.parse({
          slug: "officer",
          name: "Officer",
          guildRank: 1,
        }),
        characterSchema.parse({ slug: "leader", name: "Leader", guildRank: 0 }),
        characterSchema.parse({ slug: "unknown", name: "Unknown" }),
      ],
    }),
    now,
  );
  expect(result.rows.map((r) => r.character.slug)).toEqual([
    "leader",
    "officer",
    "unknown",
  ]);
  expect(snapshotSchema.parse(result).guildRankNames).toEqual({
    "0": "Guild Master",
    "1": "Officer",
  });
});
