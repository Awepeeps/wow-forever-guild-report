import { expect, test } from "bun:test";
import { parse } from "csv-parse/sync";
import { strFromU8, unzipSync } from "fflate";
import { importCsv } from "../src/import.ts";
import { buildTables, toCsv, toXlsx } from "../src/workbook.ts";
import { snapshot } from "./helpers.ts";

test("imports original CSV without Notes or planned specs, skipping empty lines and preserving quoted names", () => {
  const csv =
    '\uFEFFDiscord,Character Name,Ruleset,Class,Faction,Race,Level,Spec 1,Spec 2,Profession 1,Profession 2,Notes\r\nexample,Example Priest,RP PvE,Priest,Alliance,Skyborne,17,Shadow,,Alchemy, Herbalism ,"private note, omitted"\r\n,,,,,,,,,,,\r\n';
  const result = importCsv(csv);
  expect(result.config.characters).toHaveLength(1);
  expect(result.config.characters[0]?.primary?.[1]?.name).toBe("Herbalism");
  expect(result.discord).toEqual({ "us:example-priest": "example" });
  expect(JSON.stringify(result)).not.toContain("private note");
  expect(result.config.characters[0]?.talents).toEqual([]);
  expect(() => importCsv(`${csv}example,Example Priest,,,,,,,,,,\n`)).toThrow(
    "duplicate",
  );
});

test("CSV strings cannot become formulas and quoted multiline data round trips", () => {
  const csv = toCsv([
    [
      '=IMPORTXML("url")',
      " +danger",
      "@formula",
      "-formula",
      "\tformula",
      'comma, quote"\nnewline',
      0,
    ],
  ]);
  const result = parse(csv) as string[][];
  expect(result[0]?.slice(0, 5).every((c) => c.startsWith("'"))).toBe(true);
  expect(result[0]?.[5]).toBe('comma, quote"\nnewline');
  expect(result[0]?.[6]).toBe("0");
});

test("workbook has adjacent roster/profession tabs, real numeric cells, frozen headers, literal strings and freshness", () => {
  const tables = buildTables(snapshot);
  expect(tables.map((t) => t.name)).toEqual([
    "Characters",
    "Professions",
    "Recipes",
    "Guild Info",
    "Automated Export Info",
  ]);
  expect(tables[0]?.rows[1]).toContain(snapshot.generatedAt);
  expect(tables[0]?.rows[0]).toContain("Guild Rank");
  const bytes = toXlsx([
    ...tables,
    { name: "Literal", rows: [["=1+1", "<tag>&\u0000", 17]] },
  ]);
  const files = unzipSync(bytes);
  const sheet = strFromU8(
    files["xl/worksheets/sheet6.xml"] ?? new Uint8Array(),
  );
  expect(sheet).toContain("=1+1");
  expect(sheet).not.toContain("<f>");
  expect(sheet).toContain("&lt;tag&gt;&amp;");
  expect(sheet).not.toContain("\u0000");
  expect(sheet).toContain("<v>17</v>");
  expect(sheet).toContain('state="frozen"');
  expect(files["[Content_Types].xml"]).toBeDefined();
});

test("compact roster keeps skills in Professions and hides technical columns without discarding their data", () => {
  const base = snapshot.rows[0];
  if (!base) throw new Error("fixture");
  const tables = buildTables({
    ...snapshot,
    rows: [
      {
        ...base,
        character: {
          ...base.character,
          class: "Shaman",
          primary: base.character.primary.map((p) => ({
            ...p,
            tier: p.name.toLocaleLowerCase("en-US"),
          })),
          secondary: [{ name: "Cooking", tier: "Cooking", skill: 0, max: 75 }],
        },
      },
      {
        ...base,
        character: {
          ...base.character,
          slug: "unavailable-mage",
          name: "Unavailable Mage",
          primary: [],
          secondary: [],
        },
        professionStatus: "unavailable",
      },
    ],
  });
  const characters = tables[0];
  const professions = tables[1];
  if (!characters || !professions) throw new Error("fixture");
  expect(characters.rows[0]?.slice(0, 14)).toEqual([
    "Discord",
    "Character Name",
    "Class",
    "Level",
    "Guild Rank",
    "Equipped ilvl",
    "Average ilvl",
    "Last Login (UTC)",
    "Achievement Points",
    "XP (API)",
    "Talent Points",
    "API Status",
    "Player Notes (Editable)",
    "Generated At",
  ]);
  expect(
    characters.rows[0]
      ?.slice(0, 9)
      .some((header) => String(header).includes("Profession")),
  ).toBe(false);
  expect(characters.rows[0]).not.toContain("Profession 1");
  expect(JSON.stringify(characters.rows)).not.toContain("Alchemy");
  expect(
    professions.rows.some((row) =>
      row.some((cell) => String(cell).includes("Alchemy — 50/75")),
    ),
  ).toBe(true);
  expect(
    professions.rows.some((row) =>
      row.some((cell) => String(cell).includes("Cooking — 0/75")),
    ),
  ).toBe(true);
  expect(
    professions.rows.some(
      (row) => row.includes("Unavailable Mage") && row.includes("Unavailable"),
    ),
  ).toBe(true);
  const files = unzipSync(toXlsx(tables));
  const sheet = strFromU8(
    files["xl/worksheets/sheet1.xml"] ?? new Uint8Array(),
  );
  const styles = strFromU8(files["xl/styles.xml"] ?? new Uint8Array());
  expect(sheet).toContain('topLeftCell="C2"');
  expect(sheet).toContain(
    'min="15" max="15" width="25.71" customWidth="1" hidden="1"',
  );
  expect(sheet).toContain('r="C2" s="2"');
  expect(styles).toContain('rgb="FF0070DE"');
  expect(toCsv(characters.rows)).toContain("Character Slug");
});

test("profession summaries retain every tier, distinguish zero/unknown, and both tabs render rank-first order with explicit labels", () => {
  const base = snapshot.rows[0];
  if (!base) throw new Error("fixture");
  const rows = [
    {
      ...base,
      discord: "Alice",
      character: {
        ...base.character,
        slug: "officer-z",
        name: "Zed Officer",
        guildRank: 1,
      },
    },
    {
      ...base,
      discord: "Alice",
      character: {
        ...base.character,
        slug: "officer-a",
        name: "Alpha Officer",
        guildRank: 1,
      },
    },
    {
      ...base,
      discord: "Zebra",
      character: {
        ...base.character,
        slug: "leader",
        name: "Guild Leader",
        guildRank: 0,
        primary: [
          { name: "Alchemy", tier: "First", skill: 0, max: 75 },
          { name: "Alchemy", tier: "Second" },
          { name: "Herbalism", skill: 25 },
        ],
        secondary: [
          { name: "Cooking", skill: 1, max: 75 },
          { name: "Fishing", skill: 0, max: 75 },
          { name: "First Aid", max: 75 },
        ],
      },
    },
    {
      ...base,
      discord: "Bob",
      character: { ...base.character, slug: "unknown", name: "Unknown Rank" },
    },
    {
      ...base,
      discord: "",
      character: {
        ...base.character,
        slug: "unmapped",
        name: "Unmapped",
        guildRank: 1,
      },
    },
    {
      ...base,
      discord: "Aardvark",
      character: {
        ...base.character,
        slug: "veteran",
        name: "Veteran",
        guildRank: 2,
      },
    },
  ];
  const tables = buildTables({
    ...snapshot,
    guildRankNames: { "0": "Guild Master", "1": "Officer" },
    rows,
  });
  for (const t of tables.slice(0, 2))
    expect(t.rows.slice(1).map((r) => r[1])).toEqual([
      "Guild Leader",
      "Alpha Officer",
      "Zed Officer",
      "Unmapped",
      "Veteran",
      "Unknown Rank",
    ]);
  const chars = tables[0],
    prof = tables[1];
  if (!chars || !prof) throw new Error("fixture");
  expect(chars.rows[1]?.[4]).toBe("Guild Master");
  expect(chars.rows[2]?.[4]).toBe("Officer");
  expect(chars.rows[5]?.[4]).toBe("Rank 2 (unmapped)");
  expect(chars.rows[6]?.[4]).toBe("");
  expect(
    chars.rows[1]?.[chars.rows[0]?.indexOf("Guild Rank Number") ?? -1],
  ).toBe(0);
  expect(prof.rows).toHaveLength(rows.length + 1);
  expect(prof.rows[1]?.[3]).toBe(
    "Alchemy (First) — 0/75\nAlchemy (Second) — ?/?\nHerbalism — 25/?",
  );
  expect(prof.rows[1]?.[4]).toBe(
    "Cooking — 1/75\nFishing — 0/75\nFirst Aid — ?/75",
  );
  expect(prof.rows[0]?.slice(0, 7)).toEqual([
    "Discord",
    "Character Name",
    "Class",
    "Primary Professions",
    "Secondary Professions",
    "Profession API Status",
    "Player Notes (Editable)",
  ]);
  // Rendering a previously saved snapshot must not mutate its source order.
  expect(rows[0]?.character.slug).toBe("officer-z");
});

test("XLSX profession rows expose multiple lines on open and cap oversized heights", () => {
  const bytes = toXlsx([
    {
      name: "Professions",
      rows: [
        [
          "Discord",
          "Character Name",
          "Class",
          "Primary Professions",
          "Secondary Professions",
          "Profession API Status",
          "Player Notes (Editable)",
        ],
        [
          "player",
          "Example",
          "Priest",
          "Alchemy — 0/75\nHerbalism — ?/?",
          "Cooking — 1/75\nFishing — 0/75\nFirst Aid — ?/75",
          "Complete",
          "",
        ],
        [
          "player",
          "Example",
          "Priest",
          "Long profession ".repeat(500),
          "",
          "Complete",
          "",
        ],
      ],
    },
  ]);
  const files = unzipSync(bytes);
  const sheet = strFromU8(
    files["xl/worksheets/sheet1.xml"] ?? new Uint8Array(),
  );
  const height = Number(
    sheet.match(/<row r="2" ht="(\d+)" customHeight="1">/)?.[1],
  );
  expect(height).toBeGreaterThanOrEqual(45);
  expect(sheet).toContain('<row r="3" ht="409" customHeight="1">');
});
