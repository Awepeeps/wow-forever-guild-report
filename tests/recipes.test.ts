import { expect, test } from "bun:test";
import { snapshotSchema } from "../src/model.ts";
import { knowerChunks, knownRecipes, recipeCoverage } from "../src/recipes.ts";
import { buildTables } from "../src/workbook.ts";
import { snapshot } from "./helpers.ts";

test("recipe lookup preserves distinct IDs, deduplicates tiers and sorts profession/recipe and ranked knowers", () => {
  const base = snapshot.rows[0];
  if (!base) throw new Error("fixture");
  const tier = {
    name: "Alchemy",
    recipes: [
      { id: 42, name: "Tonic" },
      { id: 43, name: "Tonic" },
    ],
  };
  const input = snapshotSchema.parse({
    ...snapshot,
    rows: [
      {
        ...base,
        professionStatus: "error",
        professionFetchedAt: "2026-11-06T12:00:00.000Z",
        character: {
          ...base.character,
          id: "2",
          guildRank: 1,
          primary: [tier, { ...tier, tier: "Second" }],
          secondary: [],
        },
      },
      {
        ...base,
        professionStatus: "ok",
        discord: "Leader",
        character: {
          ...base.character,
          id: "1",
          slug: "guild-leader",
          name: "Guild Leader",
          guildRank: 0,
          primary: [tier],
          secondary: [{ name: "Cooking", recipes: [{ id: 1, name: "Bread" }] }],
        },
      },
    ],
  });
  const recipes = knownRecipes(input);
  expect(recipes.map((r) => [r.profession, r.id])).toEqual([
    ["Alchemy", 42],
    ["Alchemy", 43],
    ["Cooking", 1],
  ]);
  expect(recipes[0]?.knowers.map((r) => r.row.character.id)).toEqual([
    "1",
    "2",
  ]);
  const tables = buildTables(input);
  const lookup = tables.find((t) => t.name === "Recipes");
  expect(lookup?.rows).toHaveLength(4);
  expect(lookup?.rows[1]?.[2]).toContain(
    "Guild Leader — Leader\nExample Priest — example_discord [retained; last success: 2026-11-06T12:00:00.000Z]",
  );
  expect(lookup?.rows[1]?.[3]).toBe("Includes retained data");
  expect(lookup?.rows[3]?.[3]).toBe("Current reports");
  expect(tables.find((t) => t.name === "Guild Info")?.rows).toContainEqual([
    "Recipe Coverage (current / characters)",
    "1 / 2",
  ]);
});

test("recipe coverage distinguishes unknown, empty, partial, retained and manual data including old snapshots", () => {
  const base = snapshot.rows[0];
  if (!base) throw new Error("fixture");
  const withRecipes = {
    ...base.character,
    primary: [{ name: "Alchemy", recipes: [] }],
    secondary: [],
  };
  expect(recipeCoverage({ ...base, professionStatus: "ok" })).toBe("Unknown");
  expect(
    recipeCoverage({
      ...base,
      professionStatus: "ok",
      character: { ...base.character, primary: [], secondary: [] },
    }),
  ).toBe("Current");
  expect(
    recipeCoverage({ ...base, professionStatus: "ok", character: withRecipes }),
  ).toBe("Current");
  expect(
    recipeCoverage({
      ...base,
      professionStatus: "ok",
      character: {
        ...withRecipes,
        secondary: [{ name: "Fishing" }],
      },
    }),
  ).toBe("Partial");
  expect(
    recipeCoverage({
      ...base,
      professionStatus: "error",
      character: withRecipes,
    }),
  ).toBe("Retained");
  expect(recipeCoverage({ ...base, character: withRecipes })).toBe("Manual");
  expect(knownRecipes(snapshotSchema.parse(snapshot))).toEqual([]);
  expect(
    buildTables(snapshot).find((t) => t.name === "Recipes")?.rows,
  ).toHaveLength(1);
});

test("current evidence in another tier supersedes a retained duplicate without hiding other retained recipes", () => {
  const base = snapshot.rows[0];
  if (!base) throw new Error("fixture");
  const input = {
    ...snapshot,
    rows: [
      {
        ...base,
        professionStatus: "ok" as const,
        character: {
          ...base.character,
          primary: [
            {
              name: "Alchemy",
              tier: "First",
              recipes: [
                { id: 42, name: "Tonic" },
                { id: 43, name: "Elixir" },
              ],
              recipesRetained: true,
              recipesFetchedAt: "2026-11-05T12:00:00.000Z",
            },
            {
              name: "Alchemy",
              tier: "Second",
              recipes: [{ id: 42, name: "Tonic" }],
              recipesFetchedAt: "2026-11-07T12:00:00.000Z",
            },
          ],
          secondary: [],
        },
      },
    ],
  };
  const recipes = knownRecipes(input);
  expect(recipes.find((r) => r.id === 42)?.knowers).toHaveLength(1);
  expect(recipes.find((r) => r.id === 42)?.knowers[0]).toMatchObject({
    status: "current",
    fetchedAt: "2026-11-07T12:00:00.000Z",
  });
  expect(recipes.find((r) => r.id === 43)?.knowers[0]).toMatchObject({
    status: "retained",
    fetchedAt: "2026-11-05T12:00:00.000Z",
  });
  const row = input.rows[0];
  if (!row) throw new Error("fixture");
  expect(recipeCoverage(row)).toBe("Partial");
});

test("large knower lists continue without truncation within Excel cell limits", () => {
  const base = snapshot.rows[0];
  if (!base) throw new Error("fixture");
  const rows = Array.from({ length: 2000 }, (_, i) => ({
    ...base,
    discord: `player-${i}`,
    character: {
      ...base.character,
      id: String(i + 1),
      slug: `character-${i}`,
      name: `Character ${i}`,
    },
  }));
  const chunks = knowerChunks(
    rows.map((row) => ({ row, status: "manual", fetchedAt: null })),
  );
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((c) => c.length <= 30_000)).toBe(true);
  expect(chunks.join("\n").split("\n")).toHaveLength(2000);
});

test("character metrics preserve zero, omit XP, and keep the exact last login hidden alongside the relative display", () => {
  const base = snapshot.rows[0];
  if (!base) throw new Error("fixture");
  const table = buildTables({
    ...snapshot,
    rows: [
      {
        ...base,
        character: {
          ...base.character,
          equippedItemLevel: 0,
          averageItemLevel: 12,
          achievementPoints: 0,
          experience: 0,
          lastLoginAt: "2026-11-06T12:00:00.000Z",
        },
      },
    ],
  })[0];
  if (!table) throw new Error("fixture");
  const cell = (header: string) =>
    table.rows[1]?.[table.rows[0]?.indexOf(header) ?? -1];
  expect(cell("iLvl")).toBe(0);
  expect(cell("Average ilvl")).toBe(12);
  expect(cell("Achievement Points")).toBe(0);
  expect(table.rows[0]).not.toContain("XP (API)");
  expect(cell("Last Login")).toBe("1 day ago");
  expect(cell("Last Login (UTC)")).toBe("2026-11-06T12:00:00.000Z");
  expect(table.rows[0]?.indexOf("Character API Status")).toBe(
    (table.rows[0]?.indexOf("Last Login") ?? -1) + 1,
  );
});
