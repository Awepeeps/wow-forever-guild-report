import { expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import { HttpClient } from "../src/http.ts";
import {
  armoryUrl,
  assertPublicLink,
  guildArmoryUrl,
  hyjalItemUrl,
  itemUrl,
  recipeUrl,
  upstreamRepositoryUrl,
} from "../src/links.ts";
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
  expect(itemUrl(73001)).toBe("https://www.wowhead.com/forever/item=73001");
  expect(() => assertPublicLink(itemUrl(73001))).not.toThrow();
  for (const id of [-1, 0, 1.5, Number.NaN, 2_147_483_648])
    expect(() => itemUrl(id)).toThrow();
  expect(() => assertPublicLink(upstreamRepositoryUrl)).not.toThrow();
  expect(guildArmoryUrl("us", "example-guild")).toBe(
    "https://worldofwarcraft.blizzard.com/en-us/forever/us/armory/guild/example-guild",
  );
  expect(() =>
    assertPublicLink(guildArmoryUrl("eu", "élise-o’neil")),
  ).not.toThrow();
  expect(() => guildArmoryUrl("us", "../private")).toThrow();
  expect(() => assertPublicLink(armoryUrl("eu", "élise-o’neil"))).not.toThrow();
  for (const target of [
    "javascript:alert(1)",
    "https://github.com/deathpie/wow-forever-guild-report",
    `${upstreamRepositoryUrl}?token=private`,
    `${upstreamRepositoryUrl}/issues/new`,
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
    "https://www.wowhead.com/forever/item=0",
    "https://www.wowhead.com/forever/item=2147483648",
    "https://www.wowhead.com/forever/item=73001?token=private",
    "https://www.wowhead.com/forever/item=73001#private",
    "https://worldofwarcraft.blizzard.com/en-us/forever/us/armory/character/example/talents",
    "https://worldofwarcraft.blizzard.com/en-us/forever/us/armory/character/%2fprivate",
    "https://worldofwarcraft.blizzard.com/en-us/forever/us/armory/guild/%2fprivate",
    "https://worldofwarcraft.blizzard.com/en-us/forever/us/armory/guild/example-guild/roster",
    "https://worldofwarcraft.blizzard.com/en-us/forever/us/armory/guild/example-guild?token=private",
    "https://www.wowhead.com/forever/search?q=Example#private",
  ])
    expect(() => assertPublicLink(target)).toThrow("allowed public");
});

test("Hyjal auction links come only from a known ruleset, faction and validated item ID", () => {
  const market = { rulesetName: "Roleplay", faction: "Alliance" } as const;
  const url = hyjalItemUrl("us", market, 279941);
  expect(url).toBe("https://hyjal.cc/auctions/us/rp-pve/alliance/item/279941");
  expect(() => assertPublicLink(url ?? "")).not.toThrow();
  expect(
    hyjalItemUrl("eu", { rulesetName: "Roleplay PvP", faction: "Horde" }, 7),
  ).toBe("https://hyjal.cc/auctions/eu/rp-pvp/horde/item/7");
  for (const rulesetName of ["Invented Ruleset", "toString", "__proto__"])
    expect(
      hyjalItemUrl("us", { rulesetName, faction: "Alliance" }, 1),
    ).toBeUndefined();
  for (const id of [0, -1, 1.5, 2_147_483_648])
    expect(() => hyjalItemUrl("us", market, id)).toThrow();
  expect(() => hyjalItemUrl("xx", market, 1)).toThrow();
  for (const target of [
    "http://hyjal.cc/auctions/us/rp-pve/alliance/item/1",
    "https://hyjal.cc.evil.invalid/auctions/us/rp-pve/alliance/item/1",
    "https://hyjal.cc/auctions/us/rp-pve/alliance/item/1?token=private",
    "https://hyjal.cc/auctions/us/rp-pve/alliance/item/1#private",
    "https://hyjal.cc/auctions/us/rp-pve/alliance/item/1/tanning-rack",
    "https://hyjal.cc/auctions/us/other/alliance/item/1",
    "https://hyjal.cc/auctions/us/rp-pve/alliance/item/0",
    "https://hyjal.cc/auctions/us/rp-pve/alliance/item/2147483648",
    "https://hyjal.cc/auctions/us/rp-pve/alliance/item/1/../../../private",
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
  const guildUrl = guildArmoryUrl(snapshot.region, "example-guild");
  const guild = tables.find((t) => t.name === "Guild Info");
  expect(guild?.rows).toContainEqual(["Source Guild URL", guildUrl]);
  expect(toCsv(guild?.rows ?? [])).toContain(guildUrl);
  const guildLinks = strFromU8(
    files["xl/worksheets/_rels/sheet4.xml.rels"] ?? new Uint8Array(),
  );
  expect(guildLinks).toContain(`Target="${guildUrl}"`);
  const sourceLinks = strFromU8(
    files["xl/worksheets/_rels/sheet5.xml.rels"] ?? new Uint8Array(),
  );
  expect(sourceLinks).toContain(`Target="${upstreamRepositoryUrl}"`);
  const info = tables.find((t) => t.name === "Automated Export Info");
  expect(toCsv(info?.rows ?? [])).toContain(upstreamRepositoryUrl);
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
  expect(body).toContain(`"link":{"uri":"${guildUrl}"}`);
});

test("explicit character rosters do not invent a source guild link", () => {
  const guild = buildTables({ ...snapshot, guild: null }).find(
    (t) => t.name === "Guild Info",
  );
  expect(guild?.rows.some((row) => row[0] === "Source Guild URL")).toBe(false);
  expect(guild?.links).toEqual([]);
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
