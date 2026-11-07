import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { HttpClient } from "../src/http.ts";
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
        : { sheets: [{ properties: { sheetId: 1, title: "Human Notes" } }] },
    );
  });
  await publishSheets(tables, "example-spreadsheet-id", "test-token", http);
  expect(calls).toHaveLength(2);
  const body = String(calls[1]?.init?.body);
  expect(body).toContain('"stringValue":"=HYPERLINK');
  expect(body).not.toContain("formulaValue");
  expect(body).toContain("createDeveloperMetadata");
  expect(body).not.toContain('"sheetId":1,');
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
    sheetRequests([table], [{ sheetId: 3, title: "Characters" }], notes),
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
      sheetRequests([table], [{ sheetId: 1, title: "Characters" }], notes),
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
      sheetRequests(
        [sameSlugTable],
        [{ sheetId: 1, title: "Characters" }],
        upgraded,
      ),
    ),
  ).toContain("Human note");
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
