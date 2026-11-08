import { createSign } from "node:crypto";
import { z } from "zod";
import { relativeLoginFormula, validatedRelativeDates } from "./dates.ts";
import { readJson } from "./files.ts";
import { HttpClient, SafeError } from "./http.ts";
import {
  type ItemLinkList,
  validatedItemLists,
  validatedLinks,
} from "./links.ts";
import {
  classStyle,
  columnPresentation,
  isPlayerNotesHeader,
  playerGroups,
  rgb,
} from "./presentation.ts";
import type { Table } from "./workbook.ts";

const serviceAccountSchema = z.object({
  client_email: z.email(),
  private_key: z.string().min(1),
});
const tokenSchema = z.object({ access_token: z.string().min(1) });
const valueSchema = z.union([
  z.object({ stringValue: z.string() }).strict(),
  z.object({ numberValue: z.number() }).strict(),
  z.object({ boolValue: z.boolean() }).strict(),
  z.object({ formulaValue: z.string() }).strict(),
]);
type SheetValue = z.infer<typeof valueSchema>;
interface NoteCell {
  userEnteredValue?: SheetValue | undefined;
  userEnteredFormat?: Record<string, unknown> | undefined;
  textFormatRuns?: Record<string, unknown>[] | undefined;
}
type NotesByTable = Partial<
  Record<"Characters" | "Professions", ReadonlyMap<string, NoteCell>>
>;
function rowKey(
  row: readonly (string | number)[],
  headers: readonly (string | number)[],
): string {
  const id = row[headers.indexOf("Character ID")];
  return `${row[headers.indexOf("Region")]}:${id ? `id:${id}` : row[headers.indexOf("Character Slug")]}`;
}
function slugKey(
  row: readonly (string | number)[],
  headers: readonly (string | number)[],
): string {
  return `${row[headers.indexOf("Region")]}:${row[headers.indexOf("Character Slug")]}`;
}
const marker = "wow-forever-guild-report-v1";
const spreadsheetSchema = z.object({
  properties: z
    .object({
      timeZone: z.string().optional(),
      locale: z.string().optional(),
      autoRecalc: z.enum(["ON_CHANGE", "MINUTE", "HOUR"]).default("ON_CHANGE"),
    })
    .default({ autoRecalc: "ON_CHANGE" }),
  sheets: z.array(
    z.object({
      properties: z.object({
        sheetId: z.number().int().nonnegative(),
        title: z.string(),
      }),
      developerMetadata: z
        .array(
          z.object({
            metadataKey: z.string(),
            metadataValue: z.string().optional(),
          }),
        )
        .default([]),
    }),
  ),
});
const gridSchema = z.object({
  sheets: z.array(
    z.object({
      data: z
        .array(
          z.object({
            rowData: z
              .array(
                z.object({
                  values: z
                    .array(
                      z.object({
                        userEnteredValue: valueSchema.optional(),
                        userEnteredFormat: z
                          .record(z.string(), z.unknown())
                          .optional(),
                        textFormatRuns: z
                          .array(z.record(z.string(), z.unknown()))
                          .optional(),
                      }),
                    )
                    .default([]),
                }),
              )
              .default([]),
          }),
        )
        .default([]),
    }),
  ),
});

export function preservedNotes(
  rows: { values: NoteCell[] }[],
  table: Table,
): Map<string, NoteCell> {
  const textValue = (v: SheetValue | undefined) =>
    v && "stringValue" in v ? v.stringValue : "";
  const headers =
    rows[0]?.values.map((v) => textValue(v.userEnteredValue)) ?? [];
  const noteIndex = headers.findIndex(isPlayerNotesHeader);
  const slugIndex = headers.indexOf("Character Slug");
  const regionIndex = headers.indexOf("Region");
  const idIndex = headers.indexOf("Character ID");
  // The old long-form Professions tab had no human-owned column.
  if (
    noteIndex < 0 &&
    table.name === "Professions" &&
    ["Profession", "Category", "Skill", "Maximum"].every((h) =>
      headers.includes(h),
    )
  )
    return new Map();
  if (noteIndex < 0 && table.name === "Professions")
    throw new SafeError(
      "Unrecognized Professions headers. Restore the legacy Profession/Category/Skill/Maximum layout or the current Player Notes (Editable) column before publishing; no changes were made.",
    );
  if (headers.filter(isPlayerNotesHeader).length > 1)
    throw new SafeError(
      "Ambiguous player note headers. Resolve duplicate Notes columns before publishing; no changes were made.",
    );
  if (noteIndex < 0 || slugIndex < 0 || regionIndex < 0)
    throw new SafeError(
      "Managed player-note headers changed; restore Player Notes (Editable), Region, and Character Slug before publishing.",
    );
  const currentHeader = table.rows[0] ?? [];
  const currentIdentities = new Map(
    table.rows.slice(1).flatMap((r) => {
      const identity = rowKey(r, currentHeader);
      return [
        [identity, identity],
        [slugKey(r, currentHeader), identity],
      ];
    }),
  );
  const result = new Map<string, NoteCell>();
  for (const row of rows.slice(1)) {
    const cell = row.values[noteIndex];
    const note = cell?.userEnteredValue;
    const hasContent =
      note && !("stringValue" in note && note.stringValue === "");
    if (
      !hasContent &&
      !cell?.userEnteredFormat &&
      !cell?.textFormatRuns?.length
    )
      continue;
    const id = textValue(row.values[idIndex]?.userEnteredValue);
    const key = `${textValue(row.values[regionIndex]?.userEnteredValue)}:${id ? `id:${id}` : textValue(row.values[slugIndex]?.userEnteredValue)}`;
    // Canonicalize a slug-only row to its current stable ID before checking
    // duplicates. An old ID never falls back to a reused slug.
    const identity = currentIdentities.get(key);
    if (!identity && hasContent)
      throw new SafeError(
        "A departing or unidentified character has Notes. Archive those notes and clear their cells before publishing; no sheet changes were made.",
      );
    if (!identity) continue;
    if (result.has(identity))
      throw new SafeError(
        "Duplicate character identities have Notes. Resolve duplicates before publishing.",
      );
    result.set(identity, {
      userEnteredValue: note ?? { stringValue: "" },
      ...(cell?.userEnteredFormat
        ? { userEnteredFormat: cell.userEnteredFormat }
        : {}),
      ...(cell?.textFormatRuns ? { textFormatRuns: cell.textFormatRuns } : {}),
    });
  }
  return result;
}

async function serviceAccount(
  env: NodeJS.ProcessEnv,
): Promise<z.infer<typeof serviceAccountSchema>> {
  // Inline JSON lets a secret store inject the key without a file on disk.
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    let raw: unknown;
    try {
      raw = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch {
      throw new SafeError("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.");
    }
    const parsed = serviceAccountSchema.safeParse(raw);
    if (!parsed.success)
      throw new SafeError(
        "GOOGLE_SERVICE_ACCOUNT_JSON must contain client_email and private_key.",
      );
    return parsed.data;
  }
  if (env.GOOGLE_SERVICE_ACCOUNT_FILE)
    return readJson(env.GOOGLE_SERVICE_ACCOUNT_FILE, serviceAccountSchema);
  throw new SafeError(
    "Set GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_ACCESS_TOKEN in Varlock configuration.",
  );
}

export async function googleToken(
  env: NodeJS.ProcessEnv,
  http = new HttpClient(),
): Promise<string> {
  if (env.GOOGLE_ACCESS_TOKEN) return env.GOOGLE_ACCESS_TOKEN;
  const account = await serviceAccount(env);
  const now = Math.floor(Date.now() / 1000);
  const b64 = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: account.client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  let signature: string;
  try {
    signature = createSign("RSA-SHA256")
      .update(unsigned)
      .sign(account.private_key, "base64url");
  } catch {
    throw new SafeError("Google service account private key is invalid.");
  }
  const data = await http.json(
    "Google OAuth",
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }).toString(),
    },
  );
  const parsed = tokenSchema.safeParse(data);
  if (!parsed.success)
    throw new SafeError("Google OAuth returned an unsupported response.");
  return parsed.data.access_token;
}

function materialRuns(items: ItemLinkList["items"]): Record<string, unknown>[] {
  const runs: Record<string, unknown>[] = [];
  let offset = 0;
  for (const [index, item] of items.entries()) {
    runs.push({
      startIndex: offset,
      format: {
        link: { uri: item.url },
        foregroundColor: rgb("0563C1"),
        underline: true,
      },
    });
    offset += item.text.length; // Sheets offsets count UTF-16 code units.
    if (index < items.length - 1) {
      runs.push({ startIndex: offset, format: {} });
      offset++;
    }
  }
  return runs;
}

export function sheetRequests(
  tables: Table[],
  existing: { sheetId: number; title: string }[],
  notesByTable: NotesByTable = {},
  timeZone = "UTC",
): unknown[] {
  const used = new Set(existing.map((s) => s.sheetId));
  const requests: unknown[] = [];
  for (const [index, table] of tables.entries()) {
    const dates = new Map(
      validatedRelativeDates(table).map((date) => [
        `${date.row}:${date.column}`,
        relativeLoginFormula(date.timestamp, timeZone),
      ]),
    );
    const links = validatedLinks(table.rows, table.links);
    const itemLists = validatedItemLists(table.rows, table.itemLists, links);
    const title = table.name;
    let id = existing.find((s) => s.title === title)?.sheetId;
    const rows = table.rows.length;
    const columns = table.rows[0]?.length ?? 1;
    const frozenColumnCount = ["Characters", "Professions"].includes(title)
      ? 2
      : 0;
    const noteColumn = ["Characters", "Professions"].includes(title)
      ? (table.rows[0]?.findIndex(isPlayerNotesHeader) ?? -1)
      : -1;
    const notes =
      title === "Characters" || title === "Professions"
        ? notesByTable[title]
        : undefined;
    const noteFor = (row: (string | number)[]) =>
      notes?.get(rowKey(row, table.rows[0] ?? [])) ??
      notes?.get(slugKey(row, table.rows[0] ?? []));
    if (id === undefined) {
      id = 10_000;
      while (used.has(id)) id++;
      used.add(id);
      requests.push({
        addSheet: {
          properties: {
            sheetId: id,
            title,
            index,
            gridProperties: {
              rowCount: Math.max(rows, 2),
              columnCount: columns,
              frozenRowCount: 1,
              frozenColumnCount,
            },
          },
        },
      });
      requests.push({
        createDeveloperMetadata: {
          developerMetadata: {
            metadataKey: marker,
            metadataValue: "managed",
            location: { sheetId: id },
            visibility: "DOCUMENT",
          },
        },
      });
    } else {
      requests.push({ clearBasicFilter: { sheetId: id } });
      requests.push({
        updateSheetProperties: {
          properties: {
            sheetId: id,
            index,
            gridProperties: {
              rowCount: Math.max(rows, 2),
              columnCount: columns,
              frozenRowCount: 1,
              frozenColumnCount,
            },
          },
          fields: "gridProperties,index",
        },
      });
    }
    // Bounded range plus fields clears previous cell values, including when roster shrinks.
    requests.push({
      updateCells: {
        range: {
          sheetId: id,
          startRowIndex: 0,
          endRowIndex: Math.max(rows, 2),
          startColumnIndex: 0,
          endColumnIndex: columns,
        },
        rows: table.rows.map((row, r) => ({
          values: row.map((cell, c) => ({
            userEnteredValue:
              r > 0 && c === noteColumn
                ? (noteFor(row)?.userEnteredValue ?? { stringValue: "" })
                : dates.has(`${r}:${c}`)
                  ? { formulaValue: `=${dates.get(`${r}:${c}`)}` }
                  : typeof cell === "number"
                    ? { numberValue: cell }
                    : { stringValue: cell },
            ...(r > 0 && c === noteColumn && noteFor(row)?.textFormatRuns
              ? { textFormatRuns: noteFor(row)?.textFormatRuns }
              : {}),
          })),
        })),
        // Writing values erases old rich text. Restore human runs while clearing
        // generated runs explicitly, including materials that became unknown.
        fields: "userEnteredValue,textFormatRuns",
      },
    });
    // Shared formatting is range-based so a large guild remains one bounded batch.
    const bodyRanges =
      noteColumn < 0
        ? [[0, columns]]
        : [
            [0, noteColumn],
            [noteColumn + 1, columns],
          ];
    if (rows > 1) {
      for (const [start, end] of bodyRanges)
        if (start !== end) {
          requests.push({
            repeatCell: {
              range: {
                sheetId: id,
                startRowIndex: 1,
                endRowIndex: rows,
                startColumnIndex: start,
                endColumnIndex: end,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: rgb("FFFFFF"),
                  textFormat: { foregroundColor: rgb("172B3A"), bold: false },
                  wrapStrategy: "WRAP",
                  verticalAlignment: "TOP",
                },
              },
              fields: "userEnteredFormat",
            },
          });
          // A missing item must not keep a previous whole-cell target, even
          // when this publish contains no links in that column at all.
          requests.push({
            repeatCell: {
              range: {
                sheetId: id,
                startRowIndex: 1,
                endRowIndex: rows,
                startColumnIndex: start,
                endColumnIndex: end,
              },
              cell: {},
              fields: "userEnteredFormat.textFormat.link",
            },
          });
        }
      if (title === "Professions")
        for (const group of playerGroups(table.rows).filter((g) => g.shaded))
          requests.push({
            repeatCell: {
              range: {
                sheetId: id,
                startRowIndex: group.start,
                endRowIndex: group.end,
                startColumnIndex: 0,
                endColumnIndex: 2,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: rgb("F1F5F9"),
                },
              },
              fields: "userEnteredFormat.backgroundColor",
            },
          });
      const classColumn = table.rows[0]?.indexOf("Class") ?? -1;
      if (classColumn >= 0)
        requests.push({
          updateCells: {
            start: { sheetId: id, rowIndex: 1, columnIndex: classColumn },
            rows: table.rows.slice(1).map((row) => {
              const name = String(row[classColumn] ?? "");
              const style = classStyle(name);
              return {
                values: [
                  {
                    userEnteredFormat: {
                      backgroundColor: rgb(name ? style.background : "FFFFFF"),
                      textFormat: {
                        foregroundColor: rgb(
                          name ? style.foreground : "172B3A",
                        ),
                        bold: Boolean(name),
                      },
                      wrapStrategy: "WRAP",
                      verticalAlignment: "TOP",
                    },
                  },
                ],
              };
            }),
            fields: "userEnteredFormat",
          },
        });
      for (const column of new Set(links.map((link) => link.column))) {
        const targets = new Map(
          links
            .filter((link) => link.column === column)
            .map((link) => [link.row, link.url]),
        );
        requests.push({
          updateCells: {
            start: { sheetId: id, rowIndex: 1, columnIndex: column },
            rows: table.rows.slice(1).map((_, i) => ({
              values: [
                {
                  userEnteredFormat: {
                    textFormat: targets.has(i + 1)
                      ? {
                          link: { uri: targets.get(i + 1) },
                          foregroundColor: rgb("0563C1"),
                          underline: true,
                        }
                      : {},
                  },
                },
              ],
            })),
            fields:
              "userEnteredFormat.textFormat.link,userEnteredFormat.textFormat.foregroundColor,userEnteredFormat.textFormat.underline",
          },
        });
      }
      for (const column of new Set(itemLists.map((list) => list.column))) {
        const cells = new Map(
          itemLists
            .filter((list) => list.column === column)
            .map((list) => [list.row, list]),
        );
        requests.push({
          updateCells: {
            start: { sheetId: id, rowIndex: 1, columnIndex: column },
            rows: table.rows.slice(1).map((_, i) => ({
              values: [
                {
                  textFormatRuns: cells.has(i + 1)
                    ? materialRuns(cells.get(i + 1)?.items ?? [])
                    : [],
                },
              ],
            })),
            fields: "textFormatRuns",
          },
        });
      }
      if (noteColumn >= 0)
        requests.push({
          updateCells: {
            start: { sheetId: id, rowIndex: 1, columnIndex: noteColumn },
            rows: table.rows.slice(1).map((row) => ({
              values: [
                {
                  userEnteredFormat: noteFor(row)?.userEnteredFormat ?? {
                    wrapStrategy: "WRAP",
                    verticalAlignment: "TOP",
                  },
                },
              ],
            })),
            fields: "userEnteredFormat",
          },
        });
    }
    requests.push({
      repeatCell: {
        range: { sheetId: id, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.09, green: 0.23, blue: 0.33 },
            textFormat: {
              bold: true,
              foregroundColor: { red: 1, green: 1, blue: 1 },
            },
            wrapStrategy: "WRAP",
          },
        },
        fields: "userEnteredFormat",
      },
    });
    for (const [c, header] of (table.rows[0] ?? []).entries())
      requests.push({
        updateDimensionProperties: {
          range: {
            sheetId: id,
            dimension: "COLUMNS",
            startIndex: c,
            endIndex: c + 1,
          },
          properties: {
            pixelSize: columnPresentation(title, String(header)).width,
            hiddenByUser: columnPresentation(title, String(header)).hidden,
          },
          fields: "pixelSize,hiddenByUser",
        },
      });
    if (rows > 1)
      requests.push({
        autoResizeDimensions: {
          dimensions: {
            sheetId: id,
            dimension: "ROWS",
            startIndex: 1,
            endIndex: rows,
          },
        },
      });
    requests.push({
      setBasicFilter: {
        filter: {
          range: {
            sheetId: id,
            startRowIndex: 0,
            endRowIndex: rows,
            startColumnIndex: 0,
            endColumnIndex: columns,
          },
        },
      },
    });
  }
  return requests;
}

export async function publishSheets(
  tables: Table[],
  spreadsheetId: string,
  token: string,
  http = new HttpClient(),
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{10,200}$/.test(spreadsheetId))
    throw new SafeError(
      "GOOGLE_SPREADSHEET_ID must be a spreadsheet ID, not a URL.",
    );
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const parsed = spreadsheetSchema.safeParse(
    await http.json(
      "Google Sheets",
      `${url}?fields=properties(timeZone,autoRecalc,locale),sheets(properties(sheetId,title),developerMetadata(metadataKey,metadataValue))`,
      { headers },
    ),
  );
  if (!parsed.success)
    throw new SafeError("Google Sheets metadata has an unsupported shape.");
  if (
    tables.some((t) => t.relativeDates?.length) &&
    !parsed.data.properties.timeZone
  )
    throw new SafeError(
      "Google Sheets timezone is missing; cannot safely display relative last login. No changes were made.",
    );
  if (
    tables.some((t) => t.relativeDates?.length) &&
    parsed.data.properties.locale !== "en_US"
  )
    throw new SafeError(
      "Relative Last Login currently requires an en_US spreadsheet locale. Other formula locales are not yet validated; no changes were made.",
    );
  const owned = (sheet: (typeof parsed.data.sheets)[number]) =>
    sheet.developerMetadata.some(
      (m) => m.metadataKey === marker && m.metadataValue === "managed",
    );
  const legacyCandidates = tables.some(
    (table) => table.name === "Automated Export Info",
  )
    ? parsed.data.sheets.filter(
        (s) =>
          ["Data Notes", "Export Notes"].includes(s.properties.title) &&
          owned(s),
      )
    : [];
  const legacy = legacyCandidates[0];
  if (
    legacyCandidates.length > 1 ||
    (legacy &&
      parsed.data.sheets.some(
        (s) => s.properties.title === "Automated Export Info",
      ))
  )
    throw new SafeError(
      "Automated Export Info migration has a tab collision. Resolve legacy/target tabs before publishing; no changes were made.",
    );
  const existingSheets = parsed.data.sheets.map((s) =>
    s === legacy
      ? {
          ...s,
          properties: { ...s.properties, title: "Automated Export Info" },
        }
      : s,
  );
  for (const table of tables) {
    const existing = existingSheets.find(
      (s) => s.properties.title === table.name,
    );
    if (
      existing &&
      !existing.developerMetadata.some(
        (m) => m.metadataKey === marker && m.metadataValue === "managed",
      )
    )
      throw new SafeError(
        "Target contains an unmanaged roster tab. Use a new spreadsheet; existing human sheets were left alone.",
      );
  }
  const notes: NotesByTable = {};
  for (const title of ["Characters", "Professions"] as const) {
    if (
      !parsed.data.sheets.some((s) => s.properties.title === title) ||
      !tables.some((t) => t.name === title)
    )
      continue;
    const grid = gridSchema.safeParse(
      await http.json(
        "Google Sheets",
        `${url}?ranges=${encodeURIComponent(`'${title}'`)}&includeGridData=true&fields=sheets(data(rowData(values(userEnteredValue,userEnteredFormat,textFormatRuns))))`,
        { headers },
      ),
    );
    if (!grid.success)
      throw new SafeError(
        "Cannot safely read existing Notes. No sheet changes were made.",
      );
    const table = tables.find((t) => t.name === title);
    if (!table) throw new SafeError("Player note table is missing.");
    notes[title] = preservedNotes(
      grid.data.sheets[0]?.data[0]?.rowData ?? [],
      table,
    );
  }
  const body = JSON.stringify({
    requests: [
      ...(tables.some((t) => t.relativeDates?.length) &&
      parsed.data.properties.autoRecalc === "ON_CHANGE"
        ? [
            {
              updateSpreadsheetProperties: {
                properties: { autoRecalc: "HOUR" },
                fields: "autoRecalc",
              },
            },
          ]
        : []),
      ...(legacy
        ? [
            {
              updateSheetProperties: {
                properties: {
                  sheetId: legacy.properties.sheetId,
                  title: "Automated Export Info",
                },
                fields: "title",
              },
            },
          ]
        : []),
      ...sheetRequests(
        tables,
        existingSheets.map((s) => s.properties),
        notes,
        parsed.data.properties.timeZone ?? "UTC",
      ),
    ],
  });
  if (Buffer.byteLength(body) > 8_000_000)
    throw new SafeError(
      "Sheet update exceeds 8 MB. Export the workbook instead.",
    );
  // Batch is atomic. Never replay a write after an ambiguous network/server failure.
  await http.json(
    "Google Sheets",
    `${url}:batchUpdate`,
    { method: "POST", headers, body },
    false,
  );
}
