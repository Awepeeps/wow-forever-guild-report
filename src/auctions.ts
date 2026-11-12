import { isFatalApiError } from "./blizzard.ts";
import { ApiError, SafeError } from "./http.ts";
import {
  type AuctionBook,
  type AuctionMarket,
  auctionBookSchema,
  type RecipeDetails,
  type Snapshot,
} from "./model.ts";

export interface AuctionSource {
  auctionPrices(market: AuctionMarket): Promise<AuctionBook>;
}

export async function refreshAuctionPrices(
  snapshot: Snapshot,
  source: AuctionSource,
  previous?: Snapshot,
  now = new Date(),
): Promise<Snapshot> {
  const { auctionPrices: _discarded, ...base } = snapshot;
  const market = snapshot.auctionMarket;
  if (!market) return base;
  if (
    previous &&
    (previous.region !== snapshot.region || previous.guild !== snapshot.guild)
  )
    throw new SafeError(
      "Auction history belongs to a different guild or region.",
    );
  if (
    snapshot.rows.some(
      ({ character: c }) =>
        (c.ruleset && c.ruleset !== market.rulesetName) ||
        (market.faction !== "Blackwater" &&
          c.faction &&
          c.faction !== market.faction),
    )
  )
    throw new SafeError(
      "The verified auction market does not match the roster ruleset or faction.",
    );
  const old =
    JSON.stringify(previous?.auctionMarket) === JSON.stringify(market)
      ? previous?.auctionPrices
      : undefined;
  const attemptedAt = now.toISOString();
  try {
    const data = auctionBookSchema.parse(await source.auctionPrices(market));
    // Persist only items used by known recipes, rather than the complete market.
    const wanted = new Set<number>();
    for (const entry of Object.values(snapshot.recipeDetails ?? {})) {
      if (entry.data?.output) wanted.add(entry.data.output.id);
      for (const reagent of entry.data?.reagents ?? [])
        wanted.add(reagent.item.id);
    }
    return {
      ...base,
      auctionPrices: {
        market,
        status: "ok",
        attemptedAt,
        fetchedAt: attemptedAt,
        data: {
          ...data,
          items: Object.fromEntries(
            Object.entries(data.items).filter(([id]) => wanted.has(Number(id))),
          ),
        },
      },
    };
  } catch (error) {
    if (isFatalApiError(error)) throw error;
    return {
      ...base,
      auctionPrices: {
        market,
        status:
          error instanceof ApiError && error.status === 404
            ? "unavailable"
            : "error",
        attemptedAt,
        fetchedAt: old?.fetchedAt ?? null,
        ...(old?.data ? { data: old.data } : {}),
      },
    };
  }
}

export function auctionSnapshotAt(snapshot: Snapshot): string | undefined {
  const data = snapshot.auctionPrices?.data;
  if (!data?.auctionsUpdatedAt || !data.commoditiesUpdatedAt) return undefined;
  // Both are normalized ISO-8601 UTC strings, so lexical order is time order.
  return [data.auctionsUpdatedAt, data.commoditiesUpdatedAt].sort()[0];
}

export function auctionStatus(snapshot: Snapshot): string {
  if (!snapshot.auctionMarket) return "Not configured";
  const entry = snapshot.auctionPrices;
  if (!entry) return "Not fetched";
  if (entry.status !== "ok")
    return entry.data ? "Retained — refresh failed" : "Unavailable";
  const at = auctionSnapshotAt(snapshot);
  if (!at) return "Snapshot time not provided";
  return Date.parse(snapshot.generatedAt) - Date.parse(at) > 2 * 60 * 60 * 1000
    ? "Stale snapshot (>2h)"
    : "Snapshot";
}

/**
 * Sortable money: a spreadsheet cell stores raw copper and this number format
 * shows coins. The pattern is built only from validated numbers and fixed
 * literals, never from data text. Formats round to whole copper, the smallest
 * coin, so `text` mirrors the rendered value for format-less outputs (CSV).
 */
export interface MoneyDisplay {
  pattern: string;
  text: string;
}

function coinPattern(copper: number): string {
  return copper >= 10000
    ? '0"g "00"s "00"c"'
    : copper >= 100
      ? '0"s "00"c"'
      : '0"c"';
}

function coinText(copper: number): string {
  const gold = Math.floor(copper / 10000),
    silver = Math.floor(copper / 100) % 100,
    change = copper % 100;
  const pad = (n: number) => String(n).padStart(2, "0");
  return copper >= 10000
    ? `${gold}g ${pad(silver)}s ${pad(change)}c`
    : copper >= 100
      ? `${silver}s ${pad(change)}c`
      : `${change}c`;
}

export function moneyDisplay(
  copper: number,
  options: { signed?: boolean; upperCopper?: number } = {},
): MoneyDisplay {
  const { signed = false, upperCopper } = options;
  if (
    !Number.isFinite(copper) ||
    Math.abs(copper) > Number.MAX_SAFE_INTEGER ||
    (!signed && copper < 0) ||
    (upperCopper !== undefined &&
      (!signed ||
        !Number.isFinite(upperCopper) ||
        Math.abs(upperCopper) > Number.MAX_SAFE_INTEGER ||
        upperCopper < copper))
  )
    throw new Error("Invalid money value");
  // Spreadsheet formats round half away from zero, so round the magnitude.
  const whole = Math.round(Math.abs(copper));
  if (!signed)
    // A sub-copper average (a stack bought out below 1c each) keeps decimals.
    return copper > 0 && copper < 1
      ? { pattern: '0.00"c"', text: `${copper.toFixed(2)}c` }
      : { pattern: coinPattern(whole), text: coinText(whole) };
  const signedText = (value: number) => {
    const magnitude = Math.round(Math.abs(value));
    return magnitude === 0
      ? "±0c"
      : `${value > 0 ? "+" : "−"}${coinText(magnitude)}`;
  };
  const suffix =
    upperCopper !== undefined && upperCopper !== copper
      ? ` to ${signedText(upperCopper)}`
      : "";
  const literal = suffix ? `"${suffix}"` : "";
  const pattern =
    whole === 0
      ? Array(3).fill(`"±0c${suffix}"`).join(";")
      : `"+"${coinPattern(whole)}${literal};"−"${coinPattern(whole)}${literal}`;
  return { pattern, text: `${signedText(copper)}${suffix}` };
}

export function recipePrices(
  snapshot: Snapshot,
  details: RecipeDetails | undefined,
): {
  output: string;
  materialCost: string;
  outputCopper?: number;
  materialCopper?: number;
  outputQuantity?: number;
  margin: string;
  marginCopper?: number;
  marginHighCopper?: number;
  tone?: "gain" | "loss";
  status: string;
} {
  const data = snapshot.auctionPrices?.data;
  const output = details?.output
    ? data?.items[String(details.output.id)]
    : undefined;
  let materialCopper: number | undefined;
  let materialCost = "Unknown";
  if (data && details?.reagents !== undefined) {
    const required = new Map<number, number>();
    for (const reagent of details.reagents)
      required.set(
        reagent.item.id,
        (required.get(reagent.item.id) ?? 0) + reagent.quantity,
      );
    let total = 0;
    const missing = [...required].some(([id]) => !data.items[String(id)]);
    const insufficient = [...required].some(
      ([id, quantity]) => (data.items[String(id)]?.quantity ?? 0) < quantity,
    );
    if (missing) materialCost = "Missing buyout prices";
    else if (insufficient) materialCost = "Insufficient listings";
    else {
      for (const [id, quantity] of required)
        total += (data.items[String(id)]?.unitCopper ?? 0) * quantity;
      if (Number.isFinite(total) && total <= Number.MAX_SAFE_INTEGER) {
        materialCopper = total;
        materialCost = moneyDisplay(total).text;
      }
    }
  }
  // Margin per craft: output value at the reported yield, after the configured
  // sale cut, minus material cost. Deposits are refunded on sale, so excluded.
  // A variable yield gives a range; it is only colored when both ends agree.
  let margin = "Unknown";
  let marginCopper: number | undefined;
  let marginHighCopper: number | undefined;
  let tone: "gain" | "loss" | undefined;
  if (output && materialCopper !== undefined && details?.quantity) {
    const net =
      output.unitCopper *
      (1 - (snapshot.auctionMarket?.saleCutPercent ?? 0) / 100);
    const low = net * details.quantity.min - materialCopper,
      high = net * details.quantity.max - materialCopper;
    if (
      Math.abs(low) <= Number.MAX_SAFE_INTEGER &&
      Math.abs(high) <= Number.MAX_SAFE_INTEGER
    ) {
      marginCopper = low;
      marginHighCopper = high;
      margin = moneyDisplay(low, { signed: true, upperCopper: high }).text;
      tone =
        Math.round(low) > 0
          ? "gain"
          : Math.round(high) < 0
            ? "loss"
            : undefined;
    }
  }
  const incomplete = !output || materialCopper === undefined;
  const status = auctionStatus(snapshot);
  return {
    output: output
      ? moneyDisplay(output.unitCopper).text
      : data && details?.output
        ? "No buyout listings"
        : "Unknown",
    materialCost,
    ...(output ? { outputCopper: output.unitCopper } : {}),
    ...(materialCopper !== undefined ? { materialCopper } : {}),
    ...(data && details?.output
      ? { outputQuantity: output?.quantity ?? 0 }
      : {}),
    margin,
    ...(marginCopper !== undefined ? { marginCopper } : {}),
    ...(marginHighCopper !== undefined ? { marginHighCopper } : {}),
    ...(tone ? { tone } : {}),
    status: data && incomplete ? `${status}; some prices unavailable` : status,
  };
}

export function materialPriceSuffix(
  snapshot: Snapshot,
  itemId: number,
): string {
  if (!snapshot.auctionMarket) return "";
  const data = snapshot.auctionPrices?.data;
  const item = data?.items[String(itemId)];
  return item
    ? ` — ${moneyDisplay(item.unitCopper).text} each`
    : data
      ? " — no buyout listings"
      : " — price unknown";
}
