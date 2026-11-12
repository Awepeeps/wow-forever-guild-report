import { expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import {
  auctionSnapshotAt,
  auctionStatus,
  materialPriceSuffix,
  moneyDisplay,
  recipePrices,
  refreshAuctionPrices,
} from "../src/auctions.ts";
import { BlizzardClient } from "../src/blizzard.ts";
import { ApiError, HttpClient } from "../src/http.ts";
import {
  type AuctionBook,
  auctionMarketSchema,
  configSchema,
  snapshotSchema,
} from "../src/model.ts";
import { columnPresentation } from "../src/presentation.ts";
import { sheetRequests } from "../src/sheets.ts";
import {
  buildTables,
  displayRows,
  toCsv,
  toXlsx,
  validatedMoney,
} from "../src/workbook.ts";
import { snapshot } from "./helpers.ts";

const now = new Date("2026-11-08T13:30:00.000Z");
const market = auctionMarketSchema.parse({
  rulesetId: 8,
  rulesetName: "Invented Ruleset",
  faction: "Alliance",
  houseId: 901,
  verifiedAt: now.toISOString(),
  verification: "in-game-listings",
});
const details = {
  id: 42,
  name: "Invented Tonic",
  output: { id: 7001, name: "Invented Tonic" },
  quantity: { min: 1, max: 3 },
  reagents: [{ item: { id: 7002, name: "Invented 🌿 Herb" }, quantity: 2 }],
};
const book: AuctionBook = {
  auctionsUpdatedAt: "2026-11-08T13:00:00.000Z",
  commoditiesUpdatedAt: "2026-11-08T13:05:00.000Z",
  items: {
    "7001": { unitCopper: 1000, quantity: 8 },
    "7002": { unitCopper: 37, quantity: 25 },
  },
};
function input() {
  const row = snapshot.rows[0];
  if (!row) throw new Error("fixture");
  return snapshotSchema.parse({
    ...snapshot,
    generatedAt: now.toISOString(),
    auctionMarket: market,
    rows: [
      {
        ...row,
        character: {
          ...row.character,
          ruleset: market.rulesetName,
          faction: market.faction,
          primary: [
            { name: "Alchemy", recipes: [{ id: 42, name: "Invented Tonic" }] },
          ],
        },
      },
    ],
    recipeDetails: {
      "42": {
        status: "ok",
        fetchedAt: now.toISOString(),
        attemptedAt: now.toISOString(),
        data: details,
      },
    },
  });
}
function api(
  options: {
    regular?: unknown;
    commodities?: unknown;
    indexName?: string;
    rulesetName?: string;
    lastModified?: string;
  } = {},
) {
  const urls: URL[] = [];
  const http = new HttpClient(async (url, init) => {
    const u = new URL(url);
    urls.push(u);
    if (u.pathname === "/token")
      return Response.json({ access_token: "test-token", expires_in: 3600 });
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer test-token",
    );
    expect(u.searchParams.get("namespace")).toBe("dynamic-forever-us");
    expect(u.searchParams.has("access_token")).toBe(false);
    if (u.pathname.endsWith("/auctions/"))
      return Response.json({
        auctions: [
          {
            id: 901,
            name: options.indexName ?? "Alliance Auction House",
            key: { href: "https://untrusted.invalid/private" },
          },
        ],
      });
    if (u.pathname.endsWith("/commodities"))
      return Response.json(
        options.commodities ?? {
          auctions: [
            { id: 11, item: { id: 7002 }, quantity: 20, unit_price: 37 },
            { id: 12, item: { id: 7002 }, quantity: 5, unit_price: 50 },
          ],
        },
        {
          headers: {
            "Last-Modified":
              options.lastModified ?? "Sun, 8 Nov 2026 13:05:00 GMT",
          },
        },
      );
    if (u.pathname.endsWith("/auctions/901"))
      return Response.json(
        options.regular ?? {
          id: 901,
          name: "Alliance Auction House",
          auctions: [
            { id: 1, item: { id: 7001 }, quantity: 3, buyout: 3000 },
            { id: 2, item: { id: 7001 }, quantity: 5, buyout: 6000 },
            { id: 3, item: { id: 7003 }, quantity: 1, bid: 2 },
            { id: 4, item: { id: 7004 }, quantity: 1, buyout: 0 },
            { id: 5, item: { id: 7005 }, quantity: 3, buyout: 1 },
          ],
        },
        { headers: { "Last-Modified": "Sun, 8 Nov 2026 13:00:00 GMT" } },
      );
    expect(u.pathname).toBe("/data/wow/ruleset/8");
    return Response.json({
      id: 8,
      name: options.rulesetName ?? market.rulesetName,
    });
  });
  return {
    client: new BlizzardClient(
      { region: "us", locale: "en_US" },
      { clientId: "test", clientSecret: "test" },
      http,
    ),
    urls,
  };
}

test("verified market routes, per-unit prices, bid-only exclusion and source timestamps use the Forever contract", async () => {
  const { client, urls } = api();
  const result = await client.auctionPrices(market);
  expect(result.items["7001"]).toEqual({ unitCopper: 1000, quantity: 8 });
  expect(result.items["7002"]).toEqual({ unitCopper: 37, quantity: 25 });
  expect(result.items["7003"]).toBeUndefined();
  expect(result.items["7004"]).toBeUndefined();
  expect(result.items["7005"]?.unitCopper).toBeCloseTo(1 / 3);
  expect(result.auctionsUpdatedAt).toBe(book.auctionsUpdatedAt);
  expect(result.commoditiesUpdatedAt).toBe(book.commoditiesUpdatedAt);
  expect(urls.map((u) => u.pathname)).toEqual([
    "/token",
    "/data/wow/ruleset/8",
    "/data/wow/ruleset/8/auctions/",
    "/data/wow/ruleset/8/auctions/901",
    "/data/wow/ruleset/8/auctions/901/commodities",
  ]);
});

test("wrong markets, malformed prices, duplicate listing identities and invalid source times refuse prices", async () => {
  for (const options of [
    { indexName: "Horde Auction House" },
    { rulesetName: "Other Ruleset" },
    { regular: { id: 902, name: "Alliance Auction House" } },
    {
      commodities: {
        auctions: [{ id: 1, item: { id: 7002 }, quantity: 2, unit_price: 37 }],
      },
    },
    {
      commodities: {
        auctions: [{ id: 11, item: { id: 7002 }, quantity: 0, unit_price: 37 }],
      },
    },
    {
      commodities: {
        auctions: [{ id: 11, item: { id: 7002 }, quantity: 1, unit_price: -1 }],
      },
    },
    { lastModified: "private-invalid-value" },
  ]) {
    const { client } = api(options);
    await expect(client.auctionPrices(market)).rejects.toThrow();
  }
  const empty = await api({
    regular: { id: 901, name: "Alliance Auction House" },
    commodities: {},
  }).client.auctionPrices(market);
  expect(empty.items).toEqual({});
  expect(
    configSchema.safeParse({
      version: 1,
      region: "us",
      auctionMarket: { ...market, verification: "guessed" },
    }).success,
  ).toBe(false);
});

test("price refresh retains only recipe items, clears successful missing listings, and uses explicit configuration", async () => {
  let calls = 0;
  const source = {
    auctionPrices: async () => {
      calls++;
      return {
        ...book,
        items: { ...book.items, "9999": { unitCopper: 1, quantity: 1 } },
      };
    },
  };
  const current = await refreshAuctionPrices(input(), source, undefined, now);
  expect(calls).toBe(1);
  expect(current.auctionPrices?.data).toEqual(book);
  expect(snapshotSchema.safeParse(current).success).toBe(true);
  const missing = await refreshAuctionPrices(
    input(),
    { auctionPrices: async () => ({ ...book, items: {} }) },
    current,
    now,
  );
  expect(missing.auctionPrices?.data?.items).toEqual({});
  expect(recipePrices(missing, details).output).toBe("No buyout listings");
  expect(recipePrices(missing, details).materialCost).toBe(
    "Missing buyout prices",
  );
  // Unknown price cells are blank, so AH Data must say why each is unknown.
  expect(recipePrices(missing, details).status).toMatch(
    /; output: no buyout listings; materials: missing buyout prices$/,
  );
  const missingRecipes = buildTables(missing).find((t) => t.name === "Recipes");
  const missingValue = (header: string) =>
    missingRecipes?.rows[1]?.[missingRecipes.rows[0]?.indexOf(header) ?? -1];
  for (const header of [
    "Output AH / Item",
    "Materials AH / Craft",
    "AH Margin / Craft",
  ])
    expect(missingValue(header)).toBe("");
  expect(missingValue("Output Listed")).toBe(0);
  expect(String(missingValue("AH Data"))).toContain(
    "output: no buyout listings",
  );
  const { auctionMarket: _market, ...disabled } = input();
  const next = await refreshAuctionPrices(disabled, source, current, now);
  expect(next.auctionPrices).toBeUndefined();
  expect(calls).toBe(1);
  expect(
    snapshotSchema.safeParse({
      ...current,
      auctionMarket: { ...market, houseId: 902 },
    }).success,
  ).toBe(false);
  expect(
    snapshotSchema.safeParse({ ...current, auctionMarket: undefined }).success,
  ).toBe(false);
});

test("failures retain matching-market prices and success times; market switches and auth failures never inherit prices", async () => {
  const previous = await refreshAuctionPrices(
    input(),
    { auctionPrices: async () => book },
    undefined,
    now,
  );
  const later = new Date(now.getTime() + 3600000);
  const broken = {
    auctionPrices: async () => {
      throw new ApiError("Blizzard API", 503);
    },
  };
  const retained = await refreshAuctionPrices(
    { ...input(), generatedAt: later.toISOString() },
    broken,
    previous,
    later,
  );
  expect(retained.auctionPrices?.data).toEqual(book);
  expect(retained.auctionPrices?.fetchedAt).toBe(now.toISOString());
  expect(retained.auctionPrices?.attemptedAt).toBe(later.toISOString());
  expect(auctionStatus(retained)).toBe("Retained — refresh failed");
  const changed = await refreshAuctionPrices(
    { ...input(), auctionMarket: { ...market, houseId: 902 } },
    broken,
    previous,
    later,
  );
  expect(changed.auctionPrices?.data).toBeUndefined();
  expect(changed.auctionPrices?.fetchedAt).toBeNull();
  await expect(
    refreshAuctionPrices(
      input(),
      {
        auctionPrices: async () => {
          throw new ApiError("Blizzard API", 401);
        },
      },
      previous,
      later,
    ),
  ).rejects.toThrow("HTTP 401");
  await expect(
    refreshAuctionPrices(input(), broken, { ...previous, region: "eu" }, later),
  ).rejects.toThrow("different guild or region");
  const row = input().rows[0];
  if (!row) throw new Error("fixture");
  await expect(
    refreshAuctionPrices(
      {
        ...input(),
        rows: [{ ...row, character: { ...row.character, faction: "Horde" } }],
      },
      broken,
      previous,
      later,
    ),
  ).rejects.toThrow("does not match");
});

test("recipe costs distinguish missing data, actual zero reagents, insufficient aggregate stock, and variable output", async () => {
  const current = await refreshAuctionPrices(
    input(),
    { auctionPrices: async () => book },
    undefined,
    now,
  );
  expect(recipePrices(current, details)).toMatchObject({
    output: "10s 00c",
    outputCopper: 1000,
    outputQuantity: 8,
    materialCost: "74c",
    materialCopper: 74,
    status: "Snapshot",
  });
  expect(recipePrices(current, undefined).materialCost).toBe("Unknown");
  expect(
    recipePrices(current, { ...details, reagents: undefined }).materialCopper,
  ).toBeUndefined();
  expect(
    recipePrices(current, { ...details, reagents: [] }).materialCopper,
  ).toBe(0);
  const reagent = details.reagents[0],
    priced = current.auctionPrices;
  if (!reagent || !priced) throw new Error("fixture");
  const tooMany = {
    ...details,
    reagents: [
      { ...reagent, quantity: 20 },
      { ...reagent, quantity: 10 },
    ],
  };
  expect(recipePrices(current, tooMany).materialCost).toBe(
    "Insufficient listings",
  );
  expect(recipePrices(current, tooMany).materialCopper).toBeUndefined();
  const overflow = {
    ...current,
    auctionPrices: {
      ...priced,
      data: {
        ...book,
        items: {
          "7002": { unitCopper: Number.MAX_SAFE_INTEGER, quantity: 25 },
        },
      },
    },
  };
  expect(recipePrices(overflow, details).materialCopper).toBeUndefined();
  expect(moneyDisplay(0).text).toBe("0c");
  expect(moneyDisplay(12345).text).toBe("1g 23s 45c");
  expect(moneyDisplay(10005).text).toBe("1g 00s 05c");
  expect(moneyDisplay(1 / 3).text).toBe("0.33c");
});

test("snapshot time is Blizzard's oldest endpoint timestamp, with missing/old source times disclosed", async () => {
  const current = await refreshAuctionPrices(
    input(),
    { auctionPrices: async () => book },
    undefined,
    now,
  );
  expect(auctionSnapshotAt(current)).toBe(book.auctionsUpdatedAt ?? "");
  expect(
    auctionStatus({ ...current, generatedAt: "2026-11-08T18:00:00.000Z" }),
  ).toBe("Stale snapshot (>2h)");
  const unknown = await refreshAuctionPrices(
    input(),
    { auctionPrices: async () => ({ ...book, commoditiesUpdatedAt: null }) },
    undefined,
    now,
  );
  expect(auctionSnapshotAt(unknown)).toBeUndefined();
  expect(auctionStatus(unknown)).toBe("Snapshot time not provided");
});

test("price columns and linked material text stay literal in Sheets, CSV and XLSX, with human note columns intact", async () => {
  const current = await refreshAuctionPrices(
    input(),
    { auctionPrices: async () => book },
    undefined,
    now,
  );
  const tables = buildTables(current),
    table = tables.find((t) => t.name === "Recipes");
  if (!table) throw new Error("fixture");
  const value = (header: string) =>
    table.rows[1]?.[table.rows[0]?.indexOf(header) ?? -1];
  // Prices are raw copper so they sort numerically; the listing count is its own column.
  expect(value("Output AH / Item")).toBe(1000);
  expect(value("Output Listed")).toBe(8);
  // The fixture's invented ruleset has no Hyjal market, so nothing is guessed.
  expect(value("Hyjal AH")).toBe("No Hyjal market");
  expect(value("Hyjal URL")).toBe("");
  expect(value("Materials AH / Craft")).toBe(74);
  expect(value("Materials per Craft")).toBe("2 × Invented 🌿 Herb — 37c each");
  expect(value("AH Snapshot (UTC)")).toBe(book.auctionsUpdatedAt ?? "");
  expect(value("Output Minimum")).toBe(1);
  expect(value("Output Maximum")).toBe(3);
  expect(materialPriceSuffix(current, 7002)).toBe(" — 37c each");
  expect(table.itemLists?.[0]?.items[0]?.text).toBe(
    String(value("Materials per Craft")),
  );
  // CSV has no number formats, so it carries the coin text instead.
  expect(toCsv(displayRows(table))).toContain('"10s 00c","8"');
  expect(toCsv(displayRows(table))).toContain('"74c"');
  const body = JSON.stringify(sheetRequests(tables, []));
  expect(body).toContain("wowhead.com/forever/item=7002");
  expect(body).toContain("37c each");
  expect(body).not.toContain("formulaValue");
  for (const tab of tables.filter((t) =>
    ["Characters", "Professions"].includes(t.name),
  ))
    expect(tab.rows[0]).toContain("Player Notes (Editable)");
  const files = unzipSync(toXlsx(tables));
  expect(
    strFromU8(files["xl/worksheets/sheet3.xml"] ?? new Uint8Array()),
  ).toMatch(/t="n"><v>74<\/v>/);
  expect(
    Object.values(files)
      .map((file) => strFromU8(file))
      .join(""),
  ).not.toContain("<f>");
});

test("Hyjal AH links the crafted item for the configured market in Sheets and XLSX", async () => {
  const current = await refreshAuctionPrices(
    input(),
    { auctionPrices: async () => book },
    undefined,
    now,
  );
  const roleplay = {
    ...current,
    auctionMarket: {
      ...(current.auctionMarket ?? market),
      rulesetName: "Roleplay",
    },
  };
  const tables = buildTables(roleplay),
    table = tables.find((t) => t.name === "Recipes");
  if (!table) throw new Error("fixture");
  const column = table.rows[0]?.indexOf("Hyjal AH") ?? -1;
  expect(table.rows[0]?.[column - 2]).toBe("Output AH / Item");
  expect(table.rows[0]?.[column - 1]).toBe("Output Listed");
  expect(table.rows[0]?.[column + 1]).toBe("Materials AH / Craft");
  const outputId =
    table.rows[1]?.[table.rows[0]?.indexOf("Output Item ID") ?? -1];
  const url = `https://hyjal.cc/auctions/us/rp-pve/alliance/item/${outputId}`;
  expect(table.rows[1]?.[column]).toBe("View on Hyjal");
  expect(table.rows[1]?.at(table.rows[0]?.indexOf("Hyjal URL") ?? -1)).toBe(
    url,
  );
  expect(table.links).toContainEqual({ row: 1, column, url });
  expect(JSON.stringify(sheetRequests(tables, []))).toContain(
    `"link":{"uri":"${url}"}`,
  );
  expect(columnPresentation("Recipes", "Hyjal AH").hidden).toBe(false);
  expect(columnPresentation("Recipes", "Hyjal URL").hidden).toBe(true);
  // XLSX may widen the materials column, so locate the linked cell by text.
  const files = unzipSync(toXlsx(tables));
  const rels = strFromU8(
    files["xl/worksheets/_rels/sheet3.xml.rels"] ?? new Uint8Array(),
  );
  const rel = rels.match(
    new RegExp(`Id="(link\\d+)"[^>]*Target="${url.replaceAll(".", "\\.")}"`),
  )?.[1];
  const sheet = strFromU8(
    files["xl/worksheets/sheet3.xml"] ?? new Uint8Array(),
  );
  const ref = sheet.match(
    new RegExp(`<hyperlink ref="([A-Z]+2)" r:id="${rel}"/>`),
  )?.[1];
  expect(ref).toBeDefined();
  expect(sheet).toMatch(
    new RegExp(`<c r="${ref}"[^>]*>(?:(?!</c>).)*View on Hyjal`),
  );
  const unconfigured = buildTables({
    ...roleplay,
    auctionMarket: undefined,
  }).find((t) => t.name === "Recipes");
  expect(
    unconfigured?.rows[1]?.[unconfigured.rows[0]?.indexOf("Hyjal AH") ?? -1],
  ).toBe("Not configured");
  expect(JSON.stringify(unconfigured?.links)).not.toContain("hyjal.cc");
});

test("margin per craft uses the yield range, colors only an unambiguous gain or loss, and never colors unknowns", async () => {
  const current = await refreshAuctionPrices(
    input(),
    { auctionPrices: async () => book },
    undefined,
    now,
  );
  // 1000c × 1–3 yield minus 2 × 37c materials.
  expect(recipePrices(current, details)).toMatchObject({
    margin: "+9s 26c to +29s 26c",
    marginCopper: 926,
    tone: "gain",
  });
  const fixed = { ...details, quantity: { min: 1, max: 1 } };
  const priced = (items: AuctionBook["items"]) => ({
    ...current,
    auctionPrices: {
      ...(current.auctionPrices ?? {
        market,
        status: "ok" as const,
        attemptedAt: now.toISOString(),
        fetchedAt: now.toISOString(),
      }),
      data: { ...book, items },
    },
  });
  const loss = priced({
    "7001": { unitCopper: 50, quantity: 8 },
    "7002": { unitCopper: 37, quantity: 25 },
  });
  expect(recipePrices(loss, fixed)).toMatchObject({
    margin: "−24c",
    tone: "loss",
  });
  const even = priced({
    "7001": { unitCopper: 74, quantity: 8 },
    "7002": { unitCopper: 37, quantity: 25 },
  });
  expect(recipePrices(even, fixed).margin).toBe("±0c");
  expect(recipePrices(even, fixed).tone).toBeUndefined();
  // A half-copper loss displays as −1c (half away from zero) and is colored as one.
  const halfLoss = priced({
    "7001": { unitCopper: 73.5, quantity: 8 },
    "7002": { unitCopper: 37, quantity: 25 },
  });
  expect(recipePrices(halfLoss, fixed)).toMatchObject({
    margin: "−1c",
    tone: "loss",
  });
  // A range crossing zero keeps its sign in text but is not colored.
  const mixed = priced({
    "7001": { unitCopper: 50, quantity: 8 },
    "7002": { unitCopper: 37, quantity: 25 },
  });
  expect(recipePrices(mixed, details)).toMatchObject({
    margin: "−24c to +76c",
  });
  expect(recipePrices(mixed, details).tone).toBeUndefined();
  for (const unknown of [
    { ...details, quantity: undefined },
    { ...details, reagents: undefined },
  ]) {
    expect(recipePrices(current, unknown).margin).toBe("Unknown");
    expect(recipePrices(current, unknown).tone).toBeUndefined();
  }
  const noOutput = priced({ "7002": { unitCopper: 37, quantity: 25 } });
  expect(recipePrices(noOutput, details).margin).toBe("Unknown");

  // Sheets: every margin cell's format is rewritten; only gain/loss cells are colored.
  const tables = buildTables(loss),
    recipes = tables.find((t) => t.name === "Recipes");
  if (!recipes) throw new Error("fixture");
  const column = recipes.rows[0]?.indexOf("AH Margin / Craft") ?? -1;
  // The range sorts by its low end; the format renders the whole range.
  expect(recipes.rows[1]?.[column]).toBe(-24);
  expect(validatedMoney(recipes)).toContainEqual(
    expect.objectContaining({ row: 1, column, text: "−24c to +76c" }),
  );
  expect(recipes.tones ?? []).toEqual([]);
  const gainTables = buildTables(current),
    gain = gainTables.find((t) => t.name === "Recipes");
  expect(gain?.tones).toEqual([{ row: 1, column, tone: "gain" }]);
  const requests = sheetRequests(gainTables, []) as {
    updateCells?: {
      start?: { columnIndex: number; rowIndex: number };
      fields: string;
      rows: {
        values: { userEnteredFormat?: { backgroundColor?: unknown } }[];
      }[];
    };
  }[];
  const margin = requests.find(
    (r) =>
      r.updateCells?.start?.columnIndex === column &&
      r.updateCells.fields === "userEnteredFormat",
  )?.updateCells;
  expect(margin?.start?.rowIndex).toBe(1);
  expect(margin?.rows).toHaveLength(1);
  expect(
    margin?.rows[0]?.values[0]?.userEnteredFormat?.backgroundColor,
  ).toEqual({
    red: 0xe6 / 255,
    green: 0xf4 / 255,
    blue: 0xea / 255,
  });
  expect(JSON.stringify(requests)).not.toContain("formulaValue");

  // XLSX: the toned cell uses a dedicated style whose fill is the gain color.
  const files = unzipSync(toXlsx(gainTables));
  const styles = strFromU8(files["xl/styles.xml"] ?? new Uint8Array());
  const sheet = strFromU8(
    files["xl/worksheets/sheet3.xml"] ?? new Uint8Array(),
  );
  const cell = sheet.match(/<c r="[A-Z]+2" s="(\d+)" t="n"><v>926<\/v>/);
  const xfs = [
    ...styles.matchAll(/<xf numFmtId="(\d+)" fontId="\d+" fillId="(\d+)"/g),
  ].map((m) => Number(m[2]));
  const formats = [
    ...styles.matchAll(/<xf numFmtId="(\d+)" fontId="\d+" fillId="\d+"/g),
  ].map((m) => m[1]);
  const format = formats[Number(cell?.[1]) + 1];
  expect(styles).toContain(
    `<numFmt numFmtId="${format}" formatCode="&quot;+&quot;0&quot;s &quot;00&quot;c&quot;&quot; to +29s 26c&quot;;&quot;−&quot;0&quot;s &quot;00&quot;c&quot;&quot; to +29s 26c&quot;"/>`,
  );
  const fills = [...styles.matchAll(/<fill>(.*?)<\/fill>/g)].map((m) => m[1]);
  // cellXfs follow the single cellStyleXfs entry.
  const fill = fills[xfs[Number(cell?.[1]) + 1] ?? -1];
  expect(fill).toContain("FFE6F4EA");
  expect(styles).toMatch(/<cellXfs count="(\d+)">/);
  const declared = Number(styles.match(/<cellXfs count="(\d+)">/)?.[1]);
  expect((styles.split("<cellXfs")[1]?.match(/<xf /g) ?? []).length).toBe(
    declared,
  );
  for (const tag of ["fonts", "fills"]) {
    const count = Number(
      styles.match(new RegExp(`<${tag} count="(\\d+)">`))?.[1],
    );
    const inner = styles.split(`<${tag} count`)[1]?.split(`</${tag}>`)[0] ?? "";
    expect(
      (inner.match(new RegExp(`<${tag.slice(0, -1)}>`, "g")) ?? []).length,
    ).toBe(count);
  }
});

test("margin subtracts only the configured sale cut from output value, and Guild Info states the basis", async () => {
  const withCut = (saleCutPercent?: number) => {
    const configured = auctionMarketSchema.parse({ ...market, saleCutPercent });
    const base = input();
    return refreshAuctionPrices(
      { ...base, auctionMarket: configured },
      { auctionPrices: async () => book },
      undefined,
      now,
    );
  };
  const fixed = { ...details, quantity: { min: 2, max: 2 } };
  // 2 × 1000c × 0.95 − 74c materials.
  expect(recipePrices(await withCut(5), fixed)).toMatchObject({
    margin: "+18s 26c",
    marginCopper: 1826,
    tone: "gain",
  });
  expect(recipePrices(await withCut(undefined), fixed).marginCopper).toBe(1926);
  // A 100% cut leaves only the material cost as a loss.
  expect(recipePrices(await withCut(100), fixed)).toMatchObject({
    margin: "−74c",
    tone: "loss",
  });
  expect(() =>
    auctionMarketSchema.parse({ ...market, saleCutPercent: 101 }),
  ).toThrow();
  expect(() =>
    auctionMarketSchema.parse({ ...market, saleCutPercent: -1 }),
  ).toThrow();
  const basis = (snapshot: Awaited<ReturnType<typeof withCut>>) =>
    buildTables(snapshot)
      .find((t) => t.name === "Guild Info")
      ?.rows.find((r) => r[0] === "AH Margin Basis")?.[1];
  expect(basis(await withCut(5))).toBe(
    "After a 5% auction house cut; deposits excluded (refunded on sale)",
  );
  expect(basis(await withCut(undefined))).toBe(
    "Before the auction house cut (no sale cut configured)",
  );
});

test("margins display whole copper, and sub-copper results count as break-even", () => {
  const signed = (copper: number) => moneyDisplay(copper, { signed: true });
  expect(signed(-54.3)).toEqual({ pattern: '"+"0"c";"−"0"c"', text: "−54c" });
  expect(signed(193.55).text).toBe("+1s 94c");
  expect(signed(0.4).text).toBe("±0c");
  expect(signed(-0.4)).toEqual({
    pattern: '"±0c";"±0c";"±0c"',
    text: "±0c",
  });
  // The gold pattern splits one integer into coin groups: 1234567c = 123g 45s 67c.
  expect(moneyDisplay(1234567)).toEqual({
    pattern: '0"g "00"s "00"c"',
    text: "123g 45s 67c",
  });
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY])
    expect(() => moneyDisplay(bad)).toThrow();
  expect(() => moneyDisplay(5, { signed: true, upperCopper: 1 })).toThrow();
});

test("Sheets writes raw copper with a coin number format and clears stale formats in money columns", async () => {
  const current = await refreshAuctionPrices(
    input(),
    { auctionPrices: async () => book },
    undefined,
    now,
  );
  const tables = buildTables(current),
    recipes = tables.find((t) => t.name === "Recipes");
  if (!recipes) throw new Error("fixture");
  const header = recipes.rows[0] ?? [];
  const requests = sheetRequests(tables, []) as {
    updateCells?: {
      start?: { columnIndex: number };
      fields: string;
      rows: {
        values: {
          userEnteredValue?: unknown;
          userEnteredFormat?: { numberFormat?: unknown };
        }[];
      }[];
    };
  }[];
  const values = requests.find(
    (r) =>
      r.updateCells?.fields === "userEnteredValue,textFormatRuns" &&
      r.updateCells.rows[0]?.values.some(
        (v) =>
          JSON.stringify(v.userEnteredValue) ===
          JSON.stringify({ stringValue: "Output AH / Item" }),
      ),
  )?.updateCells;
  const outputColumn = header.indexOf("Output AH / Item");
  expect(values?.rows[1]?.values[outputColumn]?.userEnteredValue).toEqual({
    numberValue: 1000,
  });
  const formatFor = (name: string) =>
    requests.find(
      (r) =>
        r.updateCells?.start?.columnIndex === header.indexOf(name) &&
        r.updateCells.fields === "userEnteredFormat.numberFormat",
    )?.updateCells?.rows[0]?.values[0];
  expect(formatFor("Output AH / Item")).toEqual({
    userEnteredFormat: {
      numberFormat: { type: "NUMBER", pattern: '0"s "00"c"' },
    },
  });
  expect(
    formatFor("AH Margin / Craft")?.userEnteredFormat?.numberFormat,
  ).toEqual({
    type: "NUMBER",
    pattern: '"+"0"s "00"c"" to +29s 26c";"−"0"s "00"c"" to +29s 26c"',
  });
  // Unknown prices are truly blank cells (no value at all, so they sort last in
  // either direction) and get an explicit empty format, clearing old patterns.
  const unknown = buildTables({ ...current, auctionPrices: undefined });
  const unknownRecipes = unknown.find((t) => t.name === "Recipes");
  expect(unknownRecipes?.rows[1]?.[outputColumn]).toBe("");
  const blank = (sheetRequests(unknown, []) as typeof requests).find(
    (r) =>
      r.updateCells?.fields === "userEnteredValue,textFormatRuns" &&
      r.updateCells.rows[0]?.values.some(
        (v) =>
          JSON.stringify(v.userEnteredValue) ===
          JSON.stringify({ stringValue: "Output AH / Item" }),
      ),
  )?.updateCells;
  expect(blank?.rows[1]?.values[outputColumn]).toEqual({});
  const cleared = (sheetRequests(unknown, []) as typeof requests).find(
    (r) =>
      r.updateCells?.start?.columnIndex === outputColumn &&
      r.updateCells.fields === "userEnteredFormat.numberFormat",
  );
  expect(cleared?.updateCells?.rows[0]?.values[0]).toEqual({});
  // A forged annotation on a text cell or non-money column is ignored.
  expect(
    validatedMoney({
      ...recipes,
      money: [
        { row: 1, column: header.indexOf("Recipe") },
        { row: 1, column: outputColumn, upperCopper: 5 },
      ],
    }),
  ).toEqual([]);
});
