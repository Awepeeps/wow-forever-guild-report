import { isFatalApiError } from "./blizzard.ts";
import { ApiError, mapConcurrent, SafeError } from "./http.ts";
import {
  type ItemVendor,
  type ItemVendorEntry,
  itemVendorSchema,
  type RecipeDetailEntry,
  type RecipeDetails,
  recipeDetailsSchema,
  type Snapshot,
} from "./model.ts";
import { knownRecipes } from "./recipes.ts";

export interface RecipeSource {
  recipe(id: number): Promise<RecipeDetails>;
}

const cacheLifetime = 24 * 60 * 60 * 1_000;

// Static recipe data is shared across characters, fetched once per ID, and
// cached privately. Failures retain the last successful details and timestamp.
export async function refreshRecipeDetails(
  snapshot: Snapshot,
  source: RecipeSource,
  previous?: Snapshot,
  now = new Date(),
): Promise<Snapshot> {
  if (
    previous &&
    (previous.region !== snapshot.region || previous.guild !== snapshot.guild)
  )
    throw new SafeError(
      "Recipe history belongs to a different guild or region.",
    );
  const ids = [...new Set(knownRecipes(snapshot).map((recipe) => recipe.id))];
  if (ids.length > 20_000)
    throw new SafeError("Recipe detail index exceeds 20,000 recipes.");
  const build = snapshot.recipeMapping?.build;
  const entries = await mapConcurrent(
    ids,
    4,
    async (id): Promise<[string, RecipeDetailEntry]> => {
      const key = String(id);
      const old = previous?.recipeDetails?.[key];
      const age = old
        ? now.getTime() - Date.parse(old.attemptedAt)
        : Number.POSITIVE_INFINITY;
      if (old && old.build === build && age >= 0 && age < cacheLifetime)
        return [key, old];
      const attemptedAt = now.toISOString();
      try {
        const parsed = recipeDetailsSchema.safeParse(await source.recipe(id));
        if (!parsed.success || parsed.data.id !== id)
          throw new SafeError(
            "Unsupported recipe details or mismatched identity.",
          );
        return [
          key,
          {
            status: "ok",
            attemptedAt,
            fetchedAt: attemptedAt,
            ...(build ? { build } : {}),
            data: parsed.data,
          },
        ];
      } catch (error) {
        if (isFatalApiError(error)) throw error;
        return [
          key,
          {
            status:
              error instanceof ApiError && error.status === 404
                ? "unavailable"
                : "error",
            attemptedAt,
            fetchedAt: old?.fetchedAt ?? null,
            ...(old?.data
              ? old.build
                ? { build: old.build }
                : {}
              : build
                ? { build }
                : {}),
            ...(old?.data ? { data: old.data } : {}),
          },
        ];
      }
    },
  );
  return { ...snapshot, recipeDetails: Object.fromEntries(entries) };
}

export interface ItemVendorSource {
  itemVendor(id: number): Promise<ItemVendor>;
}

// Vendor sell prices for crafted outputs: static item data fetched once per
// output ID and cached privately like recipe details. A failed request
// retains the last successful price and its timestamp, labelled by status.
export async function refreshItemVendorPrices(
  snapshot: Snapshot,
  source: ItemVendorSource,
  previous?: Snapshot,
  now = new Date(),
): Promise<Snapshot> {
  if (
    previous &&
    (previous.region !== snapshot.region || previous.guild !== snapshot.guild)
  )
    throw new SafeError("Item history belongs to a different guild or region.");
  const ids = [
    ...new Set(
      Object.values(snapshot.recipeDetails ?? {}).flatMap((entry) =>
        entry.data?.output ? [entry.data.output.id] : [],
      ),
    ),
  ];
  if (ids.length > 20_000)
    throw new SafeError("Crafted item index exceeds 20,000 items.");
  const entries = await mapConcurrent(
    ids,
    4,
    async (id): Promise<[string, ItemVendorEntry]> => {
      const key = String(id);
      const old = previous?.itemVendor?.[key];
      const age = old
        ? now.getTime() - Date.parse(old.attemptedAt)
        : Number.POSITIVE_INFINITY;
      if (old && age >= 0 && age < cacheLifetime) return [key, old];
      const attemptedAt = now.toISOString();
      try {
        const parsed = itemVendorSchema.safeParse(await source.itemVendor(id));
        if (!parsed.success || parsed.data.id !== id)
          throw new SafeError(
            "Unsupported item details or mismatched identity.",
          );
        return [
          key,
          {
            status: "ok",
            attemptedAt,
            fetchedAt: attemptedAt,
            data: parsed.data,
          },
        ];
      } catch (error) {
        if (isFatalApiError(error)) throw error;
        return [
          key,
          {
            status:
              error instanceof ApiError && error.status === 404
                ? "unavailable"
                : "error",
            attemptedAt,
            fetchedAt: old?.fetchedAt ?? null,
            ...(old?.data ? { data: old.data } : {}),
          },
        ];
      }
    },
  );
  return { ...snapshot, itemVendor: Object.fromEntries(entries) };
}

export function recipeDetailStatus(
  entry: RecipeDetailEntry | undefined,
): string {
  if (!entry) return "Not fetched";
  if (entry.status !== "ok")
    return entry.data
      ? "Retained — refresh failed"
      : entry.status === "unavailable"
        ? "Unavailable"
        : "Request failed";
  return entry.data?.output &&
    entry.data.quantity &&
    entry.data.reagents !== undefined
    ? "Available"
    : "Partial — some details not reported";
}

export function craftingOutput(data: RecipeDetails | undefined): string {
  if (!data?.output) return "Not reported";
  const q = data.quantity;
  const quantity = q
    ? q.min === q.max
      ? String(q.min)
      : `${q.min}–${q.max}`
    : "?";
  return `${quantity} × ${data.output.name}`;
}

export function craftingMaterials(data: RecipeDetails | undefined): string {
  return data?.reagents === undefined
    ? "Unknown"
    : data.reagents.length
      ? data.reagents.map((r) => `${r.quantity} × ${r.item.name}`).join("\n")
      : "None reported";
}
