import { expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import {
  auctionSnapshotAt,
  auctionStatus,
  materialPriceSuffix,
  money,
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
import { sheetRequests } from "../src/sheets.ts";
import { buildTables, toCsv, toXlsx } from "../src/workbook.ts";
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
    output: "10s (8 listed)",
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
  expect(money(0)).toBe("0c");
  expect(money(12345)).toBe("1g 23s 45c");
  expect(money(1 / 3)).toBe("0.33c");
  expect(money(0.001)).toBe("<0.01c");
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
  expect(value("Output AH / Item")).toBe("10s (8 listed)");
  expect(value("Materials AH / Craft")).toBe("74c");
  expect(value("Materials per Craft")).toBe("2 × Invented 🌿 Herb — 37c each");
  expect(value("AH Snapshot (UTC)")).toBe(book.auctionsUpdatedAt ?? "");
  expect(value("Output Minimum")).toBe(1);
  expect(value("Output Maximum")).toBe(3);
  expect(materialPriceSuffix(current, 7002)).toBe(" — 37c each");
  expect(table.itemLists?.[0]?.items[0]?.text).toBe(
    String(value("Materials per Craft")),
  );
  expect(toCsv(table.rows)).toContain("74c");
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
  ).toContain("74c");
  expect(
    Object.values(files)
      .map((file) => strFromU8(file))
      .join(""),
  ).not.toContain("<f>");
});
