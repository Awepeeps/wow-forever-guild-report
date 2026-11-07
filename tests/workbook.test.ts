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
    "Guild Info",
    "Export Notes",
  ]);
  expect(tables[0]?.rows[1]).toContain(snapshot.generatedAt);
  expect(tables[0]?.rows[0]).toContain("Guild Rank");
  const bytes = toXlsx([
    ...tables,
    { name: "Literal", rows: [["=1+1", "<tag>&\u0000", 17]] },
  ]);
  const files = unzipSync(bytes);
  const sheet = strFromU8(
    files["xl/worksheets/sheet5.xml"] ?? new Uint8Array(),
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
          secondary: [{ name: "Cooking", skill: 0, max: 75 }],
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
  expect(characters.rows[0]?.slice(0, 9)).toEqual([
    "Discord",
    "Character Name",
    "Class",
    "Level",
    "Guild Rank",
    "Talent Points",
    "Notes",
    "API Status",
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
    professions.rows.some((row) => row.includes("Alchemy") && row.includes(50)),
  ).toBe(true);
  expect(
    professions.rows.some((row) => row.includes("Cooking") && row.includes(0)),
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
    'min="10" max="10" width="25.71" customWidth="1" hidden="1"',
  );
  expect(sheet).toContain('r="C2" s="2"');
  expect(styles).toContain('rgb="FF0070DE"');
  expect(toCsv(characters.rows)).toContain("Character Slug");
});
