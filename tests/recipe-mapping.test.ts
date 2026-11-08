import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { snapshotSchema } from "../src/model.ts";
import {
  downloadRecipeMapping,
  recipeMappingFromCsv,
  withRecipeMapping,
} from "../src/recipe-mapping.ts";
import { sheetRequests } from "../src/sheets.ts";
import { buildTables, toCsv, toXlsx } from "../src/workbook.ts";
import { snapshot } from "./helpers.ts";

const build = "1.60.1.70862";
const csv =
  'Spell,UntrustedReference,ID\n72001,"https://untrusted.invalid/never-follow",42001\n72002,,42002\n0,,42003\n';

test("recipe IDs resolve through the full table by ID, independent of name, with build and source provenance", () => {
  const mapping = recipeMappingFromCsv(csv, build, "2026-11-07T23:00:00.000Z");
  expect(mapping.spells).toEqual({ "42001": 72001, "42002": 72002 });
  expect(mapping.sha256).toBe(createHash("sha256").update(csv).digest("hex"));
  const base = snapshot.rows[0];
  if (!base) throw new Error("fixture");
  const mapped = withRecipeMapping(
    {
      ...snapshot,
      rows: [
        {
          ...base,
          character: {
            ...base.character,
            primary: [
              {
                name: "Alchemy",
                recipes: [
                  { id: 42001, name: "Invented Tonic" },
                  { id: 42002, name: "Invented Tonic" },
                  { id: 42003, name: "Unresolved Draught" },
                  { id: 42004, name: "Unresolved Draught" },
                ],
              },
            ],
          },
        },
      ],
    },
    mapping,
  );
  const saved = snapshotSchema.parse(JSON.parse(JSON.stringify(mapped)));
  const tables = buildTables(saved),
    recipes = tables.find((t) => t.name === "Recipes");
  if (!recipes) throw new Error("fixture");
  const header = recipes.rows[0] ?? [],
    url = header.indexOf("Recipe URL"),
    spell = header.indexOf("Wowhead Spell ID"),
    id = header.indexOf("Recipe ID");
  const first = recipes.rows.find((r) => r[id] === 42001),
    second = recipes.rows.find((r) => r[id] === 42002);
  expect(first?.[url]).toBe("https://www.wowhead.com/forever/spell=72001");
  expect(second?.[url]).toBe("https://www.wowhead.com/forever/spell=72002");
  expect(first?.[spell]).toBe(72001);
  expect(recipes.links).toHaveLength(2);
  for (const recipeId of [42003, 42004]) {
    const row = recipes.rows.find((r) => r[id] === recipeId);
    expect(row?.[url]).toBe("");
    expect(row?.[header.indexOf("Wowhead Link")]).toContain("Unmapped");
  }
  const xlsx = unzipSync(toXlsx(tables));
  const links = strFromU8(
    xlsx["xl/worksheets/_rels/sheet3.xml.rels"] ?? new Uint8Array(),
  );
  expect(links).toContain("spell=72001");
  expect(links).not.toContain("spell=42001");
  expect(toCsv(recipes.rows)).toContain("spell=72002");
  expect(JSON.stringify(sheetRequests(tables, []))).toContain(
    '"uri":"https://www.wowhead.com/forever/spell=72001"',
  );
  expect(JSON.stringify(tables)).not.toContain("/search?");
  // A recipe learned later uses the same pinned table, without a special case or network call.
  expect(
    withRecipeMapping({ ...snapshot, rows: [] }, mapping).recipeMapping?.spells[
      "42002"
    ],
  ).toBe(72002);
  const { recipeMapping: _mapping, ...oldSnapshot } = saved;
  expect(
    buildTables(oldSnapshot).find((t) => t.name === "Recipes")?.links,
  ).toHaveLength(0);
});

test("ambiguous, malformed and oversized mapping inputs stop instead of emitting wrong entities or leaking input", () => {
  for (const bad of [
    "Name,Spell\nprivate-input,123\n",
    "ID,Spell,Spell\n1,2,3\n",
    "ID,Spell\n1,2\n1,3\n",
    "ID,Spell\n1,-2\n",
    "ID,Spell\n1,2147483648\n",
    "ID,Spell\n1,=private-input\n",
    "ID,Spell\n0,2\n",
    "ID,Spell\n1,0\n",
    "ID,Spell\n1,2,3\n",
    "x".repeat(2_000_001),
  ]) {
    expect(() => recipeMappingFromCsv(bad, build)).toThrow(
      "Unsupported recipe mapping",
    );
    expect(() => recipeMappingFromCsv(bad, build)).not.toThrow("private-input");
  }
  expect(() => recipeMappingFromCsv(csv, "../private-input")).toThrow(
    "Unsupported recipe mapping",
  );
});

test("mapping download is an explicit bounded operation on the fixed host, with no redirects or runtime third-party links", async () => {
  let calls = 0;
  const mapping = await downloadRecipeMapping(build, async (url, init) => {
    calls++;
    expect(String(url)).toBe(
      `https://wago.tools/db2/SkillLineAbility/csv?build=${build}&format=csv`,
    );
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeDefined();
    return new Response(csv);
  });
  expect(calls).toBe(1);
  expect(mapping.spells["42001"]).toBe(72001);
  for (const response of [
    new Response("private-input", { status: 500 }),
    new Response("", { status: 302 }),
    new Response("x".repeat(2_000_001)),
  ])
    await expect(
      downloadRecipeMapping(build, async () => response),
    ).rejects.toThrow("Existing mapping was not changed");
  let invalidCalls = 0;
  await expect(
    downloadRecipeMapping("../../private-input", async () => {
      invalidCalls++;
      throw new Error();
    }),
  ).rejects.toThrow("Invalid Forever");
  expect(invalidCalls).toBe(0);
});
