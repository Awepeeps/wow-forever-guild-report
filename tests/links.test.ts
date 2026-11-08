import { expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import { HttpClient } from "../src/http.ts";
import { armoryUrl, assertPublicLink, recipeUrl } from "../src/links.ts";
import {
  recipeMappingFromCsv,
  withRecipeMapping,
} from "../src/recipe-mapping.ts";
import { publishSheets, sheetRequests } from "../src/sheets.ts";
import { buildTables, toCsv, toXlsx } from "../src/workbook.ts";
import { snapshot } from "./helpers.ts";

test("public links use encoded Forever slugs and validated Wowhead spell IDs", () => {
  expect(armoryUrl("us", "example-priest")).toBe(
    "https://worldofwarcraft.blizzard.com/en-us/forever/us/armory/character/example-priest",
  );
  const url = recipeUrl(72001);
  expect(url).toBe("https://www.wowhead.com/forever/spell=72001");
  expect(() => assertPublicLink(url)).not.toThrow();
  expect(() => assertPublicLink(armoryUrl("eu", "élise-o’neil"))).not.toThrow();
  for (const target of [
    "javascript:alert(1)",
    "https://www.wowhead.com/forever/search?q=a&q=b",
    "file:///etc/passwd",
    "http://www.wowhead.com/forever/search?q=Example",
    "https://www.wowhead.com.evil.invalid/forever/search?q=Example",
    "https://test:private@www.wowhead.com/forever/search?q=Example",
    "https://www.wowhead.com/forever/search?q=Example&token=private",
    "https://www.wowhead.com/forever/spell=0",
    "https://www.wowhead.com/forever/spell=2147483648",
    "https://www.wowhead.com/forever/spell=72001?token=private",
    "https://www.wowhead.com/forever/spell=72001#private",
    "https://www.wowhead.com/forever/spell=72001/../../private",
    "https://worldofwarcraft.blizzard.com/en-us/forever/us/armory/character/example/talents",
    "https://worldofwarcraft.blizzard.com/en-us/forever/us/armory/character/%2fprivate",
    "https://www.wowhead.com/forever/search?q=Example#private",
  ])
    expect(() => assertPublicLink(target)).toThrow("allowed public");
});

test("XLSX hyperlinks are validated relationships, CSV keeps URLs, and Sheets links never use formulas", () => {
  const base = snapshot.rows[0];
  if (!base) throw new Error("fixture");
  const tables = buildTables(
    withRecipeMapping(
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
                  recipes: [{ id: 42, name: "Invented Tonic & Elixir" }],
                },
              ],
            },
          },
        ],
      },
      recipeMappingFromCsv("ID,Spell\n42,72001\n", "1.60.1.70862"),
    ),
  );
  const files = unzipSync(toXlsx(tables));
  const xlsx = strFromU8(files["xl/worksheets/sheet1.xml"] ?? new Uint8Array());
  expect(xlsx).toContain('<hyperlink ref="B2" r:id="link1"/>');
  const recipes = strFromU8(
    files["xl/worksheets/_rels/sheet3.xml.rels"] ?? new Uint8Array(),
  );
  expect(recipes).toContain('TargetMode="External"');
  expect(recipes).toContain("wowhead.com/forever/spell=72001");
  expect(recipes).not.toContain("spell=42");
  expect(
    Object.values(files)
      .map((bytes) => strFromU8(bytes))
      .join(""),
  ).not.toContain("<f>");
  expect(toCsv(tables[0]?.rows ?? [])).toContain(
    "https://worldofwarcraft.blizzard.com",
  );
  const body = JSON.stringify(sheetRequests(tables, []));
  expect(body).toContain(
    '"link":{"uri":"https://worldofwarcraft.blizzard.com/',
  );
  expect(body).toContain(
    '"link":{"uri":"https://www.wowhead.com/forever/spell=72001',
  );
  expect(body).not.toContain("formulaValue");
});

test("untrusted links, duplicate cells and links into human Notes fail before a Sheets write", async () => {
  const table = buildTables(snapshot)[0];
  if (!table) throw new Error("fixture");
  const allowed = armoryUrl("us", "example-priest");
  for (const links of [
    [{ row: 1, column: 1, url: "https://evil.invalid/private-token" }],
    [
      {
        row: 1,
        column: table.rows[0]?.indexOf("Player Notes (Editable)") ?? -1,
        url: allowed,
      },
    ],
    [{ row: 0, column: 1, url: allowed }],
    [
      { row: 1, column: 1, url: allowed },
      { row: 1, column: 1, url: allowed },
    ],
  ]) {
    const invalid = { ...table, links };
    expect(() => toXlsx([invalid])).toThrow("Workbook hyperlink");
    let writes = 0;
    const http = new HttpClient(async (_, init) => {
      if (init?.method === "POST") writes++;
      return Response.json({ sheets: [] });
    });
    await expect(
      publishSheets([invalid], "example-spreadsheet-id", "test-token", http),
    ).rejects.toThrow("Workbook hyperlink");
    expect(writes).toBe(0);
  }
});
