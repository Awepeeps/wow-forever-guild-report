import { expect, test } from "bun:test";
import { refreshRecipeDetails } from "../src/crafting.ts";
import { ApiError } from "../src/http.ts";
import { snapshotSchema } from "../src/model.ts";
import { buildTables, toCsv, toXlsx } from "../src/workbook.ts";
import { snapshot } from "./helpers.ts";

const now = new Date("2026-11-08T12:00:00.000Z");
const details = {
  id: 42,
  name: "Invented Tonic",
  output: { id: 7001, name: "Invented Tonic" },
  quantity: { min: 1, max: 3 },
  reagents: [{ item: { id: 7002, name: "Invented Herb" }, quantity: 2 }],
};
function input() {
  const row = snapshot.rows[0];
  if (!row) throw new Error("fixture");
  return snapshotSchema.parse({
    ...snapshot,
    rows: [
      {
        ...row,
        character: {
          ...row.character,
          primary: [
            {
              name: "Alchemy",
              tier: "First",
              recipes: [{ id: 42, name: "Invented Tonic" }],
            },
            {
              name: "Alchemy",
              tier: "Second",
              recipes: [{ id: 42, name: "Invented Tonic" }],
            },
          ],
          secondary: [],
        },
      },
    ],
  });
}

test("recipe metadata is fetched once per ID, cached, and rendered with every material and output range", async () => {
  let calls = 0;
  const source = {
    recipe: async (id: number) => {
      calls++;
      expect(id).toBe(42);
      return details;
    },
  };
  const first = await refreshRecipeDetails(input(), source, undefined, now);
  expect(calls).toBe(1);
  const cached = await refreshRecipeDetails(
    input(),
    source,
    first,
    new Date(now.getTime() + 60_000),
  );
  expect(calls).toBe(1);
  expect(cached.recipeDetails).toEqual(first.recipeDetails);
  const table = buildTables(cached).find((t) => t.name === "Recipes");
  if (!table) throw new Error("fixture");
  const value = (header: string) =>
    table.rows[1]?.[table.rows[0]?.indexOf(header) ?? -1];
  expect(value("Makes")).toBe("1–3 × Invented Tonic");
  expect(value("Materials per Craft")).toBe("2 × Invented Herb");
  expect(value("Recipe Details")).toBe("Available");
  expect(value("Output Item ID")).toBe(7001);
  expect(toCsv(table.rows)).toContain("2 × Invented Herb");
  expect(toXlsx(buildTables(cached)).byteLength).toBeGreaterThan(0);
  const expired = await refreshRecipeDetails(
    input(),
    source,
    cached,
    new Date(now.getTime() + 86_400_000),
  );
  expect(calls).toBe(2);
  expect(expired.recipeDetails?.["42"]?.fetchedAt).not.toBe(
    first.recipeDetails?.["42"]?.fetchedAt,
  );
});

test("failed detail refresh retains values and last success; auth failures abort before producing a snapshot", async () => {
  const previous = await refreshRecipeDetails(
    input(),
    { recipe: async () => details },
    undefined,
    now,
  );
  const later = new Date(now.getTime() + 86_400_000);
  for (const status of [404, 503]) {
    const next = await refreshRecipeDetails(
      input(),
      {
        recipe: async () => {
          throw new ApiError("Blizzard API", status);
        },
      },
      previous,
      later,
    );
    expect(next.recipeDetails?.["42"]?.data).toEqual(details);
    expect(next.recipeDetails?.["42"]?.fetchedAt).toBe(now.toISOString());
    expect(next.recipeDetails?.["42"]?.attemptedAt).toBe(later.toISOString());
    const table = buildTables(next).find((t) => t.name === "Recipes");
    expect(
      table?.rows[1]?.[table.rows[0]?.indexOf("Recipe Details") ?? -1],
    ).toBe("Retained — refresh failed");
  }
  await expect(
    refreshRecipeDetails(
      input(),
      {
        recipe: async () => {
          throw new ApiError("Blizzard API", 401);
        },
      },
      previous,
      later,
    ),
  ).rejects.toThrow("HTTP 401");
  expect(previous.recipeDetails?.["42"]?.status).toBe("ok");
});

test("missing detail fields remain unknown, explicit empty reagents clear old data, and mismatched IDs are refused", async () => {
  const previous = await refreshRecipeDetails(
    input(),
    { recipe: async () => details },
    undefined,
    now,
  );
  const later = new Date(now.getTime() + 86_400_000);
  const omitted = await refreshRecipeDetails(
    input(),
    { recipe: async () => ({ id: 42, name: "Invented Tonic" }) },
    previous,
    later,
  );
  expect(omitted.recipeDetails?.["42"]?.data?.reagents).toBeUndefined();
  const table = buildTables(omitted).find((t) => t.name === "Recipes");
  expect(table?.rows[1]).toContain("Unknown");
  expect(table?.rows[1]).toContain("Not reported");
  expect(table?.rows[1]).toContain("Partial — some details not reported");
  const guild = buildTables(omitted).find((t) => t.name === "Guild Info");
  expect(guild?.rows).toContainEqual([
    "Recipe Detail Responses (successful / recipes)",
    "1 / 1",
  ]);
  expect(guild?.rows).toContainEqual([
    "Recipe Details (complete / recipes)",
    "0 / 1",
  ]);
  const empty = await refreshRecipeDetails(
    input(),
    { recipe: async () => ({ ...details, reagents: [] }) },
    previous,
    later,
  );
  expect(empty.recipeDetails?.["42"]?.data?.reagents).toEqual([]);
  const invalid = await refreshRecipeDetails(
    input(),
    { recipe: async () => ({ ...details, id: 43 }) },
    undefined,
    now,
  );
  expect(invalid.recipeDetails?.["42"]?.status).toBe("error");
  expect(invalid.recipeDetails?.["42"]?.data).toBeUndefined();
  await expect(
    refreshRecipeDetails(
      input(),
      { recipe: async () => details },
      { ...previous, region: "eu" },
      now,
    ),
  ).rejects.toThrow("different guild or region");
});

test("changing the pinned mapping build bypasses the detail cache and invalid snapshot identities are rejected", async () => {
  const previous = await refreshRecipeDetails(
    input(),
    { recipe: async () => details },
    undefined,
    now,
  );
  const changed = {
    ...input(),
    recipeMapping: {
      build: "1.60.1.70862",
      source: "wago.tools/SkillLineAbility" as const,
      sha256: "a".repeat(64),
      fetchedAt: now.toISOString(),
      spells: { "42": 72001 },
    },
  };
  let calls = 0;
  await refreshRecipeDetails(
    changed,
    {
      recipe: async () => {
        calls++;
        return details;
      },
    },
    previous,
    now,
  );
  expect(calls).toBe(1);
  expect(
    snapshotSchema.safeParse({
      ...previous,
      recipeDetails: { "43": previous.recipeDetails?.["42"] },
    }).success,
  ).toBe(false);
  expect(
    snapshotSchema.safeParse({
      ...previous,
      reportTimeZone: "Invalid/Timezone",
    }).success,
  ).toBe(false);
});
