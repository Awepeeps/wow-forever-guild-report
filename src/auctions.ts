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
  return data.auctionsUpdatedAt < data.commoditiesUpdatedAt
    ? data.auctionsUpdatedAt
    : data.commoditiesUpdatedAt;
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

export function money(copper: number): string {
  if (copper > 0 && copper < 0.01) return "<0.01c";
  const rounded = Math.round(copper * 100) / 100;
  const gold = Math.floor(rounded / 10000);
  const silver = Math.floor((rounded - gold * 10000) / 100);
  const change = Number((rounded - gold * 10000 - silver * 100).toFixed(2));
  return [
    gold ? `${gold}g` : "",
    silver ? `${silver}s` : "",
    change || (!gold && !silver) ? `${change}c` : "",
  ]
    .filter(Boolean)
    .join(" ");
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
        materialCost = money(total);
      }
    }
  }
  const incomplete = !output || materialCopper === undefined;
  const status = auctionStatus(snapshot);
  return {
    output: output
      ? `${money(output.unitCopper)} (${output.quantity} listed)`
      : data && details?.output
        ? "No buyout listings"
        : "Unknown",
    materialCost,
    ...(output ? { outputCopper: output.unitCopper } : {}),
    ...(materialCopper !== undefined ? { materialCopper } : {}),
    ...(data && details?.output
      ? { outputQuantity: output?.quantity ?? 0 }
      : {}),
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
    ? ` — ${money(item.unitCopper)} each`
    : data
      ? " — no buyout listings"
      : " — price unknown";
}
