import { createSign } from "node:crypto";
import { z } from "zod";
import { readJson } from "./files.ts";
import { HttpClient, SafeError } from "./http.ts";
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
                      z.object({ userEnteredValue: valueSchema.optional() }),
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
  rows: { values: { userEnteredValue?: SheetValue | undefined }[] }[],
  table: Table,
): Map<string, SheetValue> {
  const textValue = (v: SheetValue | undefined) =>
    v && "stringValue" in v ? v.stringValue : "";
  const headers =
    rows[0]?.values.map((v) => textValue(v.userEnteredValue)) ?? [];
  const noteIndex = headers.indexOf("Notes");
  const slugIndex = headers.indexOf("Character Slug");
  const regionIndex = headers.indexOf("Region");
  const idIndex = headers.indexOf("Character ID");
  if (noteIndex < 0 || slugIndex < 0 || regionIndex < 0)
    throw new SafeError(
      "Managed Characters headers changed; restore Notes, Region, and Character Slug before publishing.",
    );
  const currentHeader = table.rows[0] ?? [];
  const currentKeys = new Set(
    table.rows
      .slice(1)
      .flatMap((r) => [rowKey(r, currentHeader), slugKey(r, currentHeader)]),
  );
  const result = new Map<string, SheetValue>();
  for (const row of rows.slice(1)) {
    const note = row.values[noteIndex]?.userEnteredValue;
    if (!note || ("stringValue" in note && note.stringValue === "")) continue;
    const id = textValue(row.values[idIndex]?.userEnteredValue);
    const key = `${textValue(row.values[regionIndex]?.userEnteredValue)}:${id ? `id:${id}` : textValue(row.values[slugIndex]?.userEnteredValue)}`;
    if (!currentKeys.has(key))
      throw new SafeError(
        "A departing or unidentified character has Notes. Archive those notes and clear their cells before publishing; no sheet changes were made.",
      );
    if (result.has(key))
      throw new SafeError(
        "Duplicate character identities have Notes. Resolve duplicates before publishing.",
      );
    result.set(key, note);
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

export function sheetRequests(
  tables: Table[],
  existing: { sheetId: number; title: string }[],
  notes = new Map<string, SheetValue>(),
): unknown[] {
  const used = new Set(existing.map((s) => s.sheetId));
  const requests: unknown[] = [];
  for (const [index, table] of tables.entries()) {
    const title = table.name;
    let id = existing.find((s) => s.title === title)?.sheetId;
    const rows = table.rows.length;
    const columns = table.rows[0]?.length ?? 1;
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
              table.name === "Characters" &&
              r > 0 &&
              table.rows[0]?.[c] === "Notes"
                ? (notes.get(rowKey(row, table.rows[0])) ??
                  notes.get(slugKey(row, table.rows[0])) ?? { stringValue: "" })
                : typeof cell === "number"
                  ? { numberValue: cell }
                  : { stringValue: cell },
          })),
        })),
        fields: "userEnteredValue",
      },
    });
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
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId: id,
          dimension: "COLUMNS",
          startIndex: 0,
          endIndex: columns,
        },
        properties: { pixelSize: 180 },
        fields: "pixelSize",
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
      `${url}?fields=sheets(properties(sheetId,title),developerMetadata(metadataKey,metadataValue))`,
      { headers },
    ),
  );
  if (!parsed.success)
    throw new SafeError("Google Sheets metadata has an unsupported shape.");
  for (const table of tables) {
    const existing = parsed.data.sheets.find(
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
  let notes = new Map<string, SheetValue>();
  if (parsed.data.sheets.some((s) => s.properties.title === "Characters")) {
    const grid = gridSchema.safeParse(
      await http.json(
        "Google Sheets",
        `${url}?ranges=${encodeURIComponent("'Characters'")}&includeGridData=true&fields=sheets(data(rowData(values(userEnteredValue))))`,
        { headers },
      ),
    );
    if (!grid.success)
      throw new SafeError(
        "Cannot safely read existing Notes. No sheet changes were made.",
      );
    const table = tables.find((t) => t.name === "Characters");
    if (!table) throw new SafeError("Characters table is missing.");
    notes = preservedNotes(grid.data.sheets[0]?.data[0]?.rowData ?? [], table);
  }
  const body = JSON.stringify({
    requests: sheetRequests(
      tables,
      parsed.data.sheets.map((s) => s.properties),
      notes,
    ),
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
