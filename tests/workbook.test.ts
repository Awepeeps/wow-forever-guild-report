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

test("workbook has first Characters/Guild Info tabs, real numeric cells, frozen headers, literal strings and freshness", () => {
  const tables = buildTables(snapshot);
  expect(tables.map((t) => t.name)).toEqual([
    "Characters",
    "Guild Info",
    "Professions",
    "Reference Info",
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
