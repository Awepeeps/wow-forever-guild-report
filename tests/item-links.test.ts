import { expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import { HttpClient } from "../src/http.ts";
import { itemUrl } from "../src/links.ts";
import { snapshotSchema } from "../src/model.ts";
import { publishSheets, sheetRequests } from "../src/sheets.ts";
import { buildTables, type Table, toCsv, toXlsx } from "../src/workbook.ts";
import { snapshot } from "./helpers.ts";

function fixture() {
  const row = snapshot.rows[0];
  if (!row) throw new Error("fixture");
  const input = snapshotSchema.parse({
    ...snapshot,
    rows: [
      {
        ...row,
        character: {
          ...row.character,
          primary: [
            {
              name: "Alchemy",
              recipes: [
                { id: 42, name: "Invented Tonic" },
                { id: 43, name: "Unknown Draught" },
              ],
            },
          ],
          secondary: [],
        },
      },
    ],
    recipeDetails: {
      "42": {
        status: "ok",
        attemptedAt: snapshot.generatedAt,
        fetchedAt: snapshot.generatedAt,
        data: {
          id: 42,
          name: "Invented Tonic",
          output: { id: 73001, name: "Invented Tonic" },
          quantity: { min: 1, max: 2 },
          reagents: [
            { item: { id: 73002, name: "Invented 🌿 Herb" }, quantity: 2 },
            { item: { id: 73003, name: "Invented Crystal" }, quantity: 1 },
          ],
        },
      },
    },
  });
  const tables = buildTables(input),
    recipes = tables.find((t) => t.name === "Recipes");
  if (!recipes) throw new Error("fixture");
  return { tables, recipes };
}

interface Request {
  updateCells?: {
    range?: unknown;
    start?: { columnIndex: number };
    fields: string;
    rows: {
      values: {
        userEnteredValue?: { stringValue?: string };
        userEnteredFormat?: { textFormat?: { link?: { uri: string } } };
        textFormatRuns?: {
          startIndex: number;
          format: {
            link?: { uri: string };
            bold?: boolean;
            foregroundColor?: { red: number; green: number; blue: number };
            underline?: boolean;
          };
        }[];
      }[];
    }[];
  };
  repeatCell?: {
    fields: string;
    range: { startColumnIndex: number; endColumnIndex: number };
  };
}

test("crafted items and each material use their original item IDs with compact independently linked Sheets lines", () => {
  const { tables, recipes } = fixture();
  const first = recipes.itemLists?.[0];
  expect(first?.items.map((item) => item.url)).toEqual([
    itemUrl(73002),
    itemUrl(73003),
  ]);
  expect(recipes.links).toContainEqual({
    row: 1,
    column: 2,
    url: itemUrl(73001),
  });
  expect(
    recipes.links?.some((link) => link.row === 2 && link.column === 2),
  ).toBe(false);
  expect(recipes.itemLists).toHaveLength(1);
  expect(recipes.rows[0]?.[3]).toBe("Materials per Craft");
  const requests = sheetRequests(tables, []) as Request[];
  const runs = requests.find((r) => r.updateCells?.fields === "textFormatRuns")
    ?.updateCells?.rows;
  expect(runs?.[0]?.values[0]?.textFormatRuns).toEqual([
    {
      startIndex: 0,
      format: {
        link: { uri: itemUrl(73002) },
        foregroundColor: { red: 5 / 255, green: 99 / 255, blue: 193 / 255 },
        underline: true,
      },
    },
    { startIndex: "2 × Invented 🌿 Herb".length, format: {} },
    {
      startIndex: "2 × Invented 🌿 Herb\n".length,
      format: {
        link: { uri: itemUrl(73003) },
        foregroundColor: { red: 5 / 255, green: 99 / 255, blue: 193 / 255 },
        underline: true,
      },
    },
  ]);
  expect(runs?.[1]?.values[0]?.textFormatRuns).toEqual([]);
  const makes = requests.find(
    (r) =>
      r.updateCells?.start?.columnIndex === 2 &&
      r.updateCells.fields.includes("textFormat.link"),
  )?.updateCells;
  expect(
    makes?.rows[0]?.values[0]?.userEnteredFormat?.textFormat?.link?.uri,
  ).toBe(itemUrl(73001));
  expect(JSON.stringify(requests)).not.toContain("formulaValue");
  expect(toCsv(recipes.rows)).toContain(`${itemUrl(73002)}\n${itemUrl(73003)}`);
});

test("XLSX gives every material its own linked cell, preserving unknown values and following columns", () => {
  const { tables, recipes } = fixture();
  const files = unzipSync(toXlsx(tables));
  const sheet = strFromU8(
    files["xl/worksheets/sheet3.xml"] ?? new Uint8Array(),
  );
  const rels = strFromU8(
    files["xl/worksheets/_rels/sheet3.xml.rels"] ?? new Uint8Array(),
  );
  const targets = new Map(
    [...rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  const cellTargets = new Map(
    [...sheet.matchAll(/<hyperlink ref="([^"]+)" r:id="([^"]+)"/g)].map(
      (match) => [match[1], targets.get(match[2])],
    ),
  );
  expect(cellTargets.get("C2")).toBe(itemUrl(73001));
  expect(cellTargets.get("D2")).toBe(itemUrl(73002));
  expect(cellTargets.get("E2")).toBe(itemUrl(73003));
  expect(cellTargets.has("D3")).toBe(false);
  expect(sheet).toContain("Material 1");
  expect(sheet).toContain("Material 2");
  expect(sheet).toContain('r="D3"');
  expect(sheet).toContain(">Unknown</t>");
  expect(sheet).toContain('r="F2"'); // Known By follows the expanded material columns.
  expect(sheet).not.toContain("<f>");
  expect(recipes.rows[0]?.[3]).toBe("Materials per Craft"); // Pure rendering leaves Sheets/CSV intact.
});

test("invalid or conflicting material links stop both renderers before a Google write", async () => {
  const { recipes } = fixture();
  const valid = recipes.itemLists?.[0];
  if (!valid) throw new Error("fixture");
  const noteTable: Table = {
    name: "Literal",
    rows: [["Player Notes (Editable)"], ["Keep this note"]],
  };
  const invalidTables: Table[] = [
    {
      ...recipes,
      itemLists: [
        {
          ...valid,
          items: [
            {
              text: String(recipes.rows[1]?.[3]),
              url: "https://untrusted.invalid/private",
            },
          ],
        },
      ],
    },
    {
      ...recipes,
      itemLists: [
        { ...valid, items: [{ text: "Wrong material", url: itemUrl(73002) }] },
      ],
    },
    { ...recipes, itemLists: [valid, valid] },
    {
      ...recipes,
      links: [{ row: valid.row, column: valid.column, url: itemUrl(73002) }],
    },
    {
      ...recipes,
      itemLists: [
        {
          ...valid,
          items: valid.items.map((item) => ({
            ...item,
            url: "https://www.wowhead.com/forever/spell=73002",
          })),
        },
      ],
    },
    {
      ...noteTable,
      itemLists: [
        {
          row: 1,
          column: 0,
          items: [{ text: "Keep this note", url: itemUrl(73002) }],
        },
      ],
    },
  ];
  for (const table of invalidTables) {
    expect(() => toXlsx([table])).toThrow("Workbook");
    let writes = 0;
    const http = new HttpClient(async (_, init) => {
      if (init?.method === "POST") writes++;
      return Response.json({ sheets: [] });
    });
    await expect(
      publishSheets([table], "example-spreadsheet-id", "test-token", http),
    ).rejects.toThrow("Workbook");
    expect(writes).toBe(0);
  }
});

test("new writes clear obsolete generated links even when all material details are now unknown", () => {
  const { recipes } = fixture();
  const table: Table = {
    name: "Recipes",
    rows: [recipes.rows[0] ?? [], recipes.rows[2] ?? []],
  };
  const requests = sheetRequests(
    [table],
    [{ sheetId: 3, title: "Recipes" }],
  ) as Request[];
  const cells = requests.find((r) => r.updateCells?.range)?.updateCells;
  expect(cells?.fields).toContain("textFormatRuns");
  expect(
    requests.some(
      (r) =>
        r.repeatCell?.fields === "userEnteredFormat.textFormat.link" &&
        r.repeatCell.range.startColumnIndex <= 3 &&
        r.repeatCell.range.endColumnIndex > 3,
    ),
  ).toBe(true);
});

test("publishing preserves human rich-text notes while rewriting values and generated material links", async () => {
  const table = buildTables(snapshot)[0];
  if (!table) throw new Error("fixture");
  const runs = [
    {
      startIndex: 0,
      format: {
        bold: true,
        link: { uri: "https://example.invalid/human-owned" },
      },
    },
  ];
  let body = "";
  const http = new HttpClient(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      body = String(init.body);
      return Response.json({});
    }
    if (url.includes("includeGridData=true")) {
      expect(url).toContain("textFormatRuns");
      return Response.json({
        sheets: [
          {
            data: [
              {
                rowData: [
                  {
                    values: [
                      "Region",
                      "Character Slug",
                      "Player Notes (Editable)",
                    ].map((stringValue) => ({
                      userEnteredValue: { stringValue },
                    })),
                  },
                  {
                    values: [
                      { userEnteredValue: { stringValue: "us" } },
                      { userEnteredValue: { stringValue: "example-priest" } },
                      {
                        userEnteredValue: { stringValue: "Keep this note" },
                        textFormatRuns: runs,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });
    }
    return Response.json({
      sheets: [
        {
          properties: { sheetId: 3, title: "Characters" },
          developerMetadata: [
            {
              metadataKey: "wow-forever-guild-report-v1",
              metadataValue: "managed",
            },
          ],
        },
      ],
    });
  });
  await publishSheets([table], "example-spreadsheet-id", "test-token", http);
  const requests = (JSON.parse(body) as { requests: Request[] }).requests;
  const cell = requests.find((r) => r.updateCells?.range)?.updateCells?.rows[1]
    ?.values[table.rows[0]?.indexOf("Player Notes (Editable)") ?? -1];
  expect(cell?.userEnteredValue?.stringValue).toBe("Keep this note");
  expect(cell?.textFormatRuns).toEqual(runs);
});
