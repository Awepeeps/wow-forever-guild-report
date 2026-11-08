import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { HttpClient } from "../src/http.ts";
import { classStyle, rgb } from "../src/presentation.ts";
import {
  googleToken,
  preservedNotes,
  publishSheets,
  sheetRequests,
} from "../src/sheets.ts";
import { buildTables } from "../src/workbook.ts";
import { snapshot } from "./helpers.ts";

test("publishing creates only tool-owned tabs using explicit string values, never formulas from data", async () => {
  const tables = buildTables({
    ...snapshot,
    rows: snapshot.rows.map((r) => ({ ...r, discord: '=HYPERLINK("bad")' })),
  });
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const http = new HttpClient(async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json(
      String(input).includes(":batchUpdate")
        ? {}
        : {
            sheets: [
              { properties: { sheetId: 1, title: "Useful Info and Guides" } },
              {
                properties: { sheetId: 2, title: "Guide Suggestions (Manual)" },
              },
            ],
          },
    );
  });
  await publishSheets(tables, "example-spreadsheet-id", "test-token", http);
  expect(calls).toHaveLength(2);
  const body = String(calls[1]?.init?.body);
  expect(body).toContain('"stringValue":"=HYPERLINK');
  expect(body).not.toContain("formulaValue");
  expect(body).toContain("createDeveloperMetadata");
  expect(body).not.toContain('"sheetId":1,');
  expect(body).not.toContain('"sheetId":2,');
  expect(body).not.toContain('"title":"Guide Suggestions (Manual)"');
  expect(body).not.toContain('"title":"Useful Info and Guides"');
  expect(body).toContain('"title":"Characters"');
});

test("refuses tab collisions with human spreadsheets before any write", async () => {
  let calls = 0;
  const http = new HttpClient(async () => {
    calls++;
    return Response.json({
      sheets: [{ properties: { sheetId: 0, title: "Characters" } }],
    });
  });
  await expect(
    publishSheets(
      buildTables(snapshot),
      "example-spreadsheet-id",
      "test-token",
      http,
    ),
  ).rejects.toThrow("unmanaged");
  expect(calls).toBe(1);
});

test("adding Recipes refuses an existing human-owned Recipes tab without writing or adopting it", async () => {
  let writes = 0;
  const http = new HttpClient(async (_, init) => {
    if (init?.method === "POST") writes++;
    return Response.json({
      sheets: [
        { properties: { sheetId: 20, title: "Recipes" } },
        { properties: { sheetId: 21, title: "Human Notes" } },
      ],
    });
  });
  await expect(
    publishSheets(
      buildTables(snapshot),
      "example-spreadsheet-id",
      "test-token",
      http,
    ),
  ).rejects.toThrow("unmanaged");
  expect(writes).toBe(0);
});

test("human Notes follow character identity across reordering and cannot be silently discarded", () => {
  const table = buildTables(snapshot)[0];
  if (!table) throw new Error("fixture");
  const oldRows = [
    {
      values: ["Region", "Character Slug", "Notes"].map((stringValue) => ({
        userEnteredValue: { stringValue },
      })),
    },
    {
      values: ["us", "example-priest", "Human text"].map((stringValue) => ({
        userEnteredValue: { stringValue },
      })),
    },
  ];
  const notes = preservedNotes(oldRows, table);
  const body = JSON.stringify(
    sheetRequests([table], [{ sheetId: 3, title: "Characters" }], {
      Characters: notes,
    }),
  );
  expect(body).toContain('"stringValue":"Human text"');
  expect(body).not.toContain("addSheet");
  const empty = { ...table, rows: table.rows.slice(0, 1) };
  expect(() => preservedNotes(oldRows, empty)).toThrow("departing");
  expect(() =>
    preservedNotes([...oldRows, oldRows[1] ?? { values: [] }], table),
  ).toThrow("Duplicate");
});

test("Notes follow stable IDs through renames and survive the first slug-to-ID upgrade", () => {
  const row = snapshot.rows[0];
  if (!row) throw new Error("fixture");
  const table = buildTables({
    ...snapshot,
    rows: [
      {
        ...row,
        character: {
          ...row.character,
          id: "123",
          slug: "renamed-priest",
          name: "Renamed Priest",
        },
      },
    ],
  })[0];
  if (!table) throw new Error("fixture");
  const oldRows = [
    {
      values: ["Region", "Character Slug", "Character ID", "Notes"].map(
        (stringValue) => ({ userEnteredValue: { stringValue } }),
      ),
    },
    {
      values: ["us", "example-priest", "123", "Human note"].map(
        (stringValue) => ({ userEnteredValue: { stringValue } }),
      ),
    },
  ];
  const notes = preservedNotes(oldRows, table);
  expect(
    JSON.stringify(
      sheetRequests([table], [{ sheetId: 1, title: "Characters" }], {
        Characters: notes,
      }),
    ),
  ).toContain("Human note");
  const sameSlugTable = buildTables({
    ...snapshot,
    rows: [{ ...row, character: { ...row.character, id: "123" } }],
  })[0];
  if (!sameSlugTable) throw new Error("fixture");
  const missingIdRows = oldRows.map((r, i) =>
    i
      ? {
          values: r.values.map((v, c) =>
            c === 2 ? { userEnteredValue: { stringValue: "" } } : v,
          ),
        }
      : r,
  );
  const upgraded = preservedNotes(missingIdRows, sameSlugTable);
  expect(
    JSON.stringify(
      sheetRequests([sameSlugTable], [{ sheetId: 1, title: "Characters" }], {
        Characters: upgraded,
      }),
    ),
  ).toContain("Human note");
});

test("Notes formatting follows identity even for empty cells when rows reorder", () => {
  const base = snapshot.rows[0];
  if (!base) throw new Error("fixture");
  const table = buildTables({
    ...snapshot,
    rows: [
      {
        ...base,
        character: { ...base.character, slug: "second", name: "AAA Second" },
      },
      base,
    ],
  })[0];
  if (!table) throw new Error("fixture");
  const formats = [
    { textFormat: { bold: true } },
    { backgroundColor: { red: 0.8 } },
  ];
  const oldRows = [
    {
      values: ["Region", "Character Slug", "Notes"].map((stringValue) => ({
        userEnteredValue: { stringValue },
      })),
    },
    ...["example-priest", "second"].map((slug, i) => ({
      values: [
        { userEnteredValue: { stringValue: "us" } },
        { userEnteredValue: { stringValue: slug } },
        {
          userEnteredValue: { stringValue: i === 0 ? "" : "Human note" },
          userEnteredFormat: formats[i],
        },
      ],
    })),
  ];
  const notes = preservedNotes(oldRows, table);
  const requests = sheetRequests(
    [table],
    [{ sheetId: 3, title: "Characters" }],
    { Characters: notes },
  ) as {
    updateCells?: {
      start?: { columnIndex: number };
      rows: { values: { userEnteredFormat?: unknown }[] }[];
    };
    repeatCell?: {
      range: {
        startRowIndex: number;
        startColumnIndex?: number;
        endColumnIndex?: number;
      };
    };
  }[];
  const restored = requests.find(
    (r) =>
      r.updateCells?.start?.columnIndex ===
      table.rows[0]?.indexOf("Player Notes (Editable)"),
  )?.updateCells;
  expect(restored?.rows.map((r) => r.values[0]?.userEnteredFormat)).toEqual([
    formats[1],
    formats[0],
  ]);
  for (const request of requests) {
    const range = request.repeatCell?.range;
    if (range?.startRowIndex === 1)
      expect(
        (range.endColumnIndex ?? Infinity) <=
          (table.rows[0]?.indexOf("Player Notes (Editable)") ?? -1) ||
          (range.startColumnIndex ?? 0) >
            (table.rows[0]?.indexOf("Player Notes (Editable)") ?? -1),
      ).toBe(true);
  }
});

test("Sheets writes are never retried after ambiguous server errors", async () => {
  let writes = 0;
  const http = new HttpClient(
    async (input) => {
      if (String(input).includes(":batchUpdate")) {
        writes++;
        return new Response("private body", { status: 503 });
      }
      return Response.json({ sheets: [] });
    },
    async () => {},
  );
  await expect(
    publishSheets(
      buildTables(snapshot),
      "example-spreadsheet-id",
      "test-token",
      http,
    ),
  ).rejects.toThrow("HTTP 503");
  expect(writes).toBe(1);
});

test("Google credentials are command-specific and short-lived OAuth tokens can be injected", async () => {
  await expect(googleToken({})).rejects.toThrow("GOOGLE_SERVICE_ACCOUNT_FILE");
  expect(
    await googleToken({ GOOGLE_ACCESS_TOKEN: "temporary-test-token" }),
  ).toBe("temporary-test-token");
});

test("layout migration renames only owned Data Notes in the same batch and preserves Notes through column removal", async () => {
  const tables = buildTables(snapshot);
  const humanFormat = {
    textFormat: { bold: true, foregroundColor: { red: 0.7 } },
    backgroundColor: { green: 0.8 },
  };
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const http = new HttpClient(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes(":batchUpdate")) return Response.json({});
    if (url.includes("includeGridData"))
      return Response.json({
        sheets: [
          {
            data: [
              {
                rowData: [
                  {
                    values: [
                      "Discord",
                      "Profession 1",
                      "Notes",
                      "Region",
                      "Character Slug",
                    ].map((stringValue) => ({
                      userEnteredValue: { stringValue },
                    })),
                  },
                  {
                    values: [
                      "example",
                      "Alchemy",
                      "Keep this human note",
                      "us",
                      "example-priest",
                    ].map((stringValue, index) => ({
                      userEnteredValue: { stringValue },
                      ...(index === 2
                        ? { userEnteredFormat: humanFormat }
                        : {}),
                    })),
                  },
                ],
              },
            ],
          },
        ],
      });
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
        {
          properties: { sheetId: 6, title: "Data Notes" },
          developerMetadata: [
            {
              metadataKey: "wow-forever-guild-report-v1",
              metadataValue: "managed",
            },
          ],
        },
        { properties: { sheetId: 9, title: "Reference Info" } },
      ],
    });
  });
  await publishSheets(tables, "example-spreadsheet-id", "test-token", http);
  const body = JSON.parse(String(calls[2]?.init?.body)) as {
    requests: {
      updateSheetProperties?: {
        properties: { sheetId: number; title?: string };
      };
      updateCells?: {
        range?: { sheetId: number };
        start?: { sheetId: number; columnIndex: number };
        rows: {
          values: {
            userEnteredValue?: { stringValue?: string };
            userEnteredFormat?: unknown;
          }[];
        }[];
      };
    }[];
  };
  expect(body.requests[0]?.updateSheetProperties?.properties).toEqual({
    sheetId: 6,
    title: "Automated Export Info",
  });
  const updatedCharacters = body.requests.find(
    (r) => r.updateCells?.range?.sheetId === 3,
  )?.updateCells;
  expect(
    updatedCharacters?.rows[1]?.values[
      buildTables(snapshot)[0]?.rows[0]?.indexOf("Player Notes (Editable)") ??
        -1
    ]?.userEnteredValue?.stringValue,
  ).toBe("Keep this human note");
  expect(
    body.requests.find(
      (r) =>
        r.updateCells?.start?.sheetId === 3 &&
        r.updateCells.start.columnIndex ===
          (buildTables(snapshot)[0]?.rows[0]?.indexOf(
            "Player Notes (Editable)",
          ) ?? -1),
    )?.updateCells?.rows[0]?.values[0]?.userEnteredFormat,
  ).toEqual(humanFormat);
  expect(JSON.stringify(body)).not.toContain('"sheetId":9');
  expect(
    calls.filter((call) => call.url.includes(":batchUpdate")),
  ).toHaveLength(1);
});

test("an unmanaged Data Notes stays untouched, and an Export Notes collision stops the rename before writing", async () => {
  for (const collision of [false, true]) {
    let writes = 0;
    let batch = "";
    const http = new HttpClient(async (input, init) => {
      if (String(input).includes(":batchUpdate")) {
        writes++;
        batch = String(init?.body);
        return Response.json({});
      }
      return Response.json({
        sheets: [
          {
            properties: { sheetId: 6, title: "Data Notes" },
            ...(collision
              ? {
                  developerMetadata: [
                    {
                      metadataKey: "wow-forever-guild-report-v1",
                      metadataValue: "managed",
                    },
                  ],
                }
              : {}),
          },
          ...(collision
            ? [{ properties: { sheetId: 8, title: "Automated Export Info" } }]
            : []),
        ],
      });
    });
    const publish = publishSheets(
      buildTables(snapshot),
      "example-spreadsheet-id",
      "test-token",
      http,
    );
    if (collision) {
      await expect(publish).rejects.toThrow("collision");
      expect(writes).toBe(0);
    } else {
      await publish;
      expect(writes).toBe(1);
      expect(batch).not.toContain('"sheetId":6');
    }
  }
});

test("class formatting preserves names, uses readable text, and hides diagnostics rather than Notes", () => {
  const row = snapshot.rows[0];
  if (!row) throw new Error("fixture");
  const table = buildTables({
    ...snapshot,
    rows: [{ ...row, character: { ...row.character, class: "Shaman" } }],
  })[0];
  if (!table) throw new Error("fixture");
  const requests = sheetRequests(
    [table],
    [{ sheetId: 3, title: "Characters" }],
  ) as {
    updateCells?: {
      start?: { columnIndex: number };
      rows: {
        values: {
          userEnteredValue?: { stringValue?: string };
          userEnteredFormat?: {
            backgroundColor: unknown;
            textFormat: { foregroundColor: unknown };
          };
        }[];
      }[];
    };
    updateDimensionProperties?: {
      range: { startIndex: number };
      properties: { hiddenByUser: boolean };
    };
  }[];
  const classValue = requests.find((r) => r.updateCells)?.updateCells?.rows[1]
    ?.values[table.rows[0]?.indexOf("Class") ?? -1];
  const classCell = requests.find(
    (r) =>
      r.updateCells?.start?.columnIndex === table.rows[0]?.indexOf("Class"),
  )?.updateCells?.rows[0]?.values[0];
  expect(classValue?.userEnteredValue?.stringValue).toBe("Shaman");
  expect(classCell?.userEnteredFormat?.backgroundColor).toEqual(rgb("0070DE"));
  expect(classCell?.userEnteredFormat?.textFormat.foregroundColor).toEqual(
    rgb("FFFFFF"),
  );
  expect(classStyle("Unknown Class").background).toBe("E5E7EB");
  expect(classStyle("__proto__").background).toBe("E5E7EB");
  const dimensions = requests.flatMap((r) =>
    r.updateDimensionProperties ? [r.updateDimensionProperties] : [],
  );
  expect(
    dimensions.find(
      (d) =>
        d.range.startIndex ===
        table.rows[0]?.indexOf("Player Notes (Editable)"),
    )?.properties.hiddenByUser,
  ).toBe(false);
  expect(
    dimensions.find(
      (d) => d.range.startIndex === table.rows[0]?.indexOf("Generated At"),
    )?.properties.hiddenByUser,
  ).toBe(true);
});

test("large guild formatting stays within a single bounded Sheets batch", () => {
  const base = snapshot.rows[0];
  if (!base) throw new Error("fixture");
  const tables = buildTables({
    ...snapshot,
    rows: Array.from({ length: 500 }, (_, i) => ({
      ...base,
      character: {
        ...base.character,
        slug: `synthetic-character-${i}`,
        name: `Synthetic Character ${i}`,
        class: "Shaman",
        primary: ["Alchemy", "Herbalism"].map((name) => ({
          name,
          skill: 50,
          max: 75,
        })),
        secondary: ["Cooking", "Fishing", "First Aid"].map((name) => ({
          name,
          skill: 50,
          max: 75,
        })),
      },
    })),
  });
  const bytes = Buffer.byteLength(
    JSON.stringify({ requests: sheetRequests(tables, []) }),
  );
  expect(bytes).toBeLessThan(4_000_000);
});

test("an inline service-account key mints a token and malformed keys never echo their content", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const bodies: string[] = [];
  const http = new HttpClient(async (_input, init) => {
    bodies.push(String(init?.body));
    return Response.json({ access_token: "minted-test-token" });
  });
  const key = JSON.stringify({
    client_email: "robot@example.iam.gserviceaccount.com",
    private_key: pem,
  });
  expect(
    await googleToken(
      {
        GOOGLE_SERVICE_ACCOUNT_JSON: key,
        GOOGLE_SERVICE_ACCOUNT_FILE: "/nonexistent/should-not-be-read.json",
      },
      http,
    ),
  ).toBe("minted-test-token");
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toContain("grant_type=");
  expect(bodies[0]).not.toContain("PRIVATE KEY");

  const secretish = "not-json-but-secret-material";
  const bad = googleToken({ GOOGLE_SERVICE_ACCOUNT_JSON: secretish }, http);
  await expect(bad).rejects.toThrow("not valid JSON");
  await expect(bad).rejects.not.toThrow(secretish);
  await expect(
    googleToken(
      { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ private_key: pem }) },
      http,
    ),
  ).rejects.toThrow("client_email and private_key");
});

test("both tabs preserve independent player notes and formats by ID through rank sorting and header migration", async () => {
  const base = snapshot.rows[0];
  if (!base) throw new Error("fixture");
  const current = {
    ...snapshot,
    rows: [
      {
        ...base,
        character: {
          ...base.character,
          id: "2",
          slug: "second",
          name: "Second",
          guildRank: 1,
        },
      },
      { ...base, character: { ...base.character, id: "1", guildRank: 0 } },
    ],
  };
  const tables = buildTables(current);
  const titles = ["Characters", "Professions"];
  const owner = [
    { metadataKey: "wow-forever-guild-report-v1", metadataValue: "managed" },
  ];
  const batches: {
    requests: {
      updateCells?: {
        start?: { sheetId: number; columnIndex: number };
        range?: { sheetId: number };
        rows: {
          values: {
            userEnteredValue?: { stringValue?: string };
            userEnteredFormat?: unknown;
          }[];
        }[];
      };
    }[];
  }[] = [];
  const format = { textFormat: { bold: true } };
  const http = new HttpClient(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(":batchUpdate")) {
      batches.push(JSON.parse(String(init?.body)));
      return Response.json({});
    }
    if (!url.searchParams.has("includeGridData"))
      return Response.json({
        sheets: titles.map((title, i) => ({
          properties: { title, sheetId: i + 1 },
          developerMetadata: owner,
        })),
      });
    const title =
      url.searchParams.get("ranges") === "'Characters'"
        ? "Characters"
        : "Professions";
    const header = title === "Characters" ? "Notes" : "Player Notes (Editable)";
    const rows = [
      {
        values: ["Region", "Character Slug", "Character ID", header].map(
          (stringValue) => ({ userEnteredValue: { stringValue } }),
        ),
      },
      ...["2", "1"].map((id) => ({
        values: [
          { userEnteredValue: { stringValue: "us" } },
          {
            userEnteredValue: {
              stringValue: id === "1" ? "old-priest" : "second",
            },
          },
          { userEnteredValue: { stringValue: id } },
          {
            userEnteredValue: { stringValue: `${title} note ${id}` },
            userEnteredFormat: format,
          },
        ],
      })),
    ];
    return Response.json({ sheets: [{ data: [{ rowData: rows }] }] });
  });
  await publishSheets(tables, "example-spreadsheet-id", "test-token", http);
  expect(batches).toHaveLength(1);
  for (const [i, title] of titles.entries()) {
    const cells = batches[0]?.requests.find(
      (r) => r.updateCells?.range?.sheetId === i + 1,
    )?.updateCells;
    const noteColumn =
      tables[i]?.rows[0]?.indexOf("Player Notes (Editable)") ?? -1;
    expect(
      cells?.rows[1]?.values[noteColumn]?.userEnteredValue?.stringValue,
    ).toBe(`${title} note 1`);
    expect(
      cells?.rows[2]?.values[noteColumn]?.userEnteredValue?.stringValue,
    ).toBe(`${title} note 2`);
    const styles = batches[0]?.requests.find(
      (r) =>
        r.updateCells?.start?.sheetId === i + 1 &&
        r.updateCells.start.columnIndex === noteColumn,
    )?.updateCells;
    expect(styles?.rows[0]?.values[0]?.userEnteredFormat).toEqual(format);
  }
});

test("legacy profession rows compact safely, but missing or ambiguous editable columns and departing notes stop writes", async () => {
  const table = buildTables(snapshot)[1];
  if (!table) throw new Error("fixture");
  const legacy = [
    {
      values: [
        "Region",
        "Character Slug",
        "Profession",
        "Category",
        "Skill",
        "Maximum",
      ].map((stringValue) => ({ userEnteredValue: { stringValue } })),
    },
  ];
  expect(preservedNotes(legacy, table).size).toBe(0);
  const cell = (stringValue: string) => ({ userEnteredValue: { stringValue } });
  expect(() =>
    preservedNotes(
      [
        {
          values: ["Region", "Character Slug", "Primary Professions"].map(cell),
        },
      ],
      table,
    ),
  ).toThrow("headers");
  expect(() =>
    preservedNotes(
      [
        {
          values: [
            "Region",
            "Character Slug",
            "Notes",
            "Player Notes (Editable)",
          ].map(cell),
        },
      ],
      table,
    ),
  ).toThrow("Ambiguous");
  let writes = 0;
  const http = new HttpClient(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(":batchUpdate")) {
      writes++;
      return Response.json({});
    }
    if (!url.searchParams.has("includeGridData"))
      return Response.json({
        sheets: [
          {
            properties: { sheetId: 2, title: "Professions" },
            developerMetadata: [
              {
                metadataKey: "wow-forever-guild-report-v1",
                metadataValue: "managed",
              },
            ],
          },
        ],
      });
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
                  ].map(cell),
                },
                { values: ["us", "departed", "Retain human text"].map(cell) },
              ],
            },
          ],
        },
      ],
    });
  });
  await expect(
    publishSheets(
      buildTables(snapshot),
      "example-spreadsheet-id",
      "test-token",
      http,
    ),
  ).rejects.toThrow("departing");
  expect(writes).toBe(0);
});

test("owned Export Notes migrates in place; two owned legacy tabs are refused", async () => {
  for (const duplicate of [false, true]) {
    let body = "";
    const owner = [
      { metadataKey: "wow-forever-guild-report-v1", metadataValue: "managed" },
    ];
    const http = new HttpClient(async (input, init) => {
      if (String(input).includes(":batchUpdate")) {
        body = String(init?.body);
        return Response.json({});
      }
      return Response.json({
        sheets: [
          {
            properties: { sheetId: 4, title: "Export Notes" },
            developerMetadata: owner,
          },
          ...(duplicate
            ? [
                {
                  properties: { sheetId: 5, title: "Data Notes" },
                  developerMetadata: owner,
                },
              ]
            : []),
        ],
      });
    });
    const publish = publishSheets(
      buildTables(snapshot),
      "example-spreadsheet-id",
      "test-token",
      http,
    );
    if (duplicate) {
      await expect(publish).rejects.toThrow("collision");
      expect(body).toBe("");
    } else {
      await publish;
      expect(body).toContain('"sheetId":4,"title":"Automated Export Info"');
    }
  }
});

test("slug-only and ID Notes resolving to the same character abort, while conflicting old IDs cannot attach to a reused slug", async () => {
  const base = snapshot.rows[0];
  if (!base) throw new Error("fixture");
  const table = buildTables({
    ...snapshot,
    rows: [{ ...base, character: { ...base.character, id: "123" } }],
  })[0];
  if (!table) throw new Error("fixture");
  const cell = (stringValue: string) => ({ userEnteredValue: { stringValue } });
  const header = {
    values: ["Region", "Character Slug", "Character ID", "Notes"].map(cell),
  };
  const slugRow = {
    values: ["us", "example-priest", "", "Slug note"].map(cell),
  };
  const idRow = {
    values: ["us", "example-priest", "123", "ID note"].map(cell),
  };
  for (const data of [
    [slugRow, idRow],
    [idRow, slugRow],
  ]) {
    const rows = [header, ...data];
    expect(() => preservedNotes(rows, table)).toThrow("Duplicate");
    let writes = 0;
    const http = new HttpClient(async (input) => {
      if (String(input).includes(":batchUpdate")) {
        writes++;
        return Response.json({});
      }
      if (String(input).includes("includeGridData"))
        return Response.json({ sheets: [{ data: [{ rowData: rows }] }] });
      return Response.json({
        sheets: [
          {
            properties: { sheetId: 1, title: "Characters" },
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
    await expect(
      publishSheets([table], "example-spreadsheet-id", "test-token", http),
    ).rejects.toThrow("Duplicate");
    expect(writes).toBe(0);
  }
  const conflicting = {
    values: ["us", "example-priest", "999", "Old identity note"].map(cell),
  };
  expect(() => preservedNotes([header, conflicting], table)).toThrow(
    "departing",
  );
});

test("one atomic upgrade handles legacy Characters notes and repeated long-form profession rows together", async () => {
  const owner = [
    { metadataKey: "wow-forever-guild-report-v1", metadataValue: "managed" },
  ];
  const cell = (stringValue: string) => ({ userEnteredValue: { stringValue } });
  let batch:
    | {
        requests: {
          updateCells?: {
            range?: { sheetId: number };
            rows: {
              values: { userEnteredValue?: { stringValue?: string } }[];
            }[];
          };
          updateSheetProperties?: {
            properties: { sheetId: number; title?: string };
          };
        }[];
      }
    | undefined;
  let writes = 0;
  const http = new HttpClient(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(":batchUpdate")) {
      writes++;
      batch = JSON.parse(String(init?.body));
      return Response.json({});
    }
    if (!url.searchParams.has("includeGridData"))
      return Response.json({
        sheets: ["Characters", "Professions", "Export Notes"].map(
          (title, i) => ({
            properties: { sheetId: i + 1, title },
            developerMetadata: owner,
          }),
        ),
      });
    const rows =
      url.searchParams.get("ranges") === "'Characters'"
        ? [
            { values: ["Region", "Character Slug", "Notes"].map(cell) },
            {
              values: ["us", "example-priest", "Preserve legacy text"].map(
                cell,
              ),
            },
          ]
        : [
            {
              values: [
                "Region",
                "Character Slug",
                "Profession",
                "Category",
                "Skill",
                "Maximum",
              ].map(cell),
            },
            {
              values: [
                "us",
                "example-priest",
                "Alchemy",
                "Primary",
                "50",
                "75",
              ].map(cell),
            },
            {
              values: [
                "us",
                "example-priest",
                "Cooking",
                "Secondary",
                "20",
                "75",
              ].map(cell),
            },
          ];
    return Response.json({ sheets: [{ data: [{ rowData: rows }] }] });
  });
  await publishSheets(
    buildTables(snapshot),
    "example-spreadsheet-id",
    "test-token",
    http,
  );
  expect(writes).toBe(1);
  expect(batch?.requests[0]?.updateSheetProperties?.properties).toEqual({
    sheetId: 3,
    title: "Automated Export Info",
  });
  expect(
    batch?.requests.find((r) => r.updateCells?.range?.sheetId === 1)
      ?.updateCells?.rows[1]?.values[
      buildTables(snapshot)[0]?.rows[0]?.indexOf("Player Notes (Editable)") ??
        -1
    ]?.userEnteredValue?.stringValue,
  ).toBe("Preserve legacy text");
  expect(
    batch?.requests.find((r) => r.updateCells?.range?.sheetId === 2)
      ?.updateCells?.rows,
  ).toHaveLength(2);
});
