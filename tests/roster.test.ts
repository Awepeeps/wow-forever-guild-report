import { describe, expect, test } from "bun:test";
import { ApiError } from "../src/http.ts";
import { characterSchema, configSchema, snapshotSchema } from "../src/model.ts";
import { refreshRoster } from "../src/roster.ts";
import { config, now, snapshot, source } from "./helpers.ts";

describe("guild roster refresh", () => {
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
