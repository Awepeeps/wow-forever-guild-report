import {
  characterIdentity,
  type RosterRow,
  type Snapshot,
  sortRows,
} from "./model.ts";

export interface KnownRecipe {
  profession: string;
  id: number;
  name: string;
  knowers: RecipeKnower[];
}
export interface RecipeKnower {
  row: RosterRow;
  status: "current" | "retained" | "manual";
  fetchedAt: string | null;
}

// Names are labels; recipe IDs are the identity. The same recipe can appear in
// more than one tier without making a character count twice.
export function knownRecipes(snapshot: Snapshot): KnownRecipe[] {
  const recipes = new Map<string, KnownRecipe>();
  for (const row of sortRows([...snapshot.rows])) {
    for (const profession of [
      ...row.character.primary,
      ...row.character.secondary,
    ]) {
      for (const recipe of profession.recipes ?? []) {
        const key = `${profession.name.toLocaleLowerCase("en-US")}:${recipe.id}`;
        let entry = recipes.get(key);
        if (!entry) {
          entry = {
            profession: profession.name,
            id: recipe.id,
            name: recipe.name,
            knowers: [],
          };
          recipes.set(key, entry);
        }
        const knower: RecipeKnower = {
          row,
          status:
            row.professionStatus === "manual"
              ? "manual"
              : row.professionStatus !== "ok" || profession.recipesRetained
                ? "retained"
                : "current",
          fetchedAt:
            profession.recipesFetchedAt === undefined
              ? row.professionFetchedAt
              : profession.recipesFetchedAt,
        };
        const previous = entry.knowers.find(
          (k) =>
            characterIdentity(k.row.character) ===
            characterIdentity(row.character),
        );
        if (!previous) entry.knowers.push(knower);
        else if (
          (previous.status === "retained" && knower.status === "current") ||
          (previous.status === knower.status &&
            (knower.fetchedAt ?? "") > (previous.fetchedAt ?? ""))
        ) {
          previous.status = knower.status;
          previous.fetchedAt = knower.fetchedAt;
        }
      }
    }
  }
  const compare = (a: string, b: string) =>
    a.localeCompare(b, "en", { sensitivity: "base" }) ||
    a.localeCompare(b, "en");
  return [...recipes.values()].sort(
    (a, b) =>
      compare(a.profession, b.profession) ||
      compare(a.name, b.name) ||
      a.id - b.id,
  );
}

export function recipeCoverage(
  row: RosterRow,
): "Current" | "Partial" | "Unknown" | "Retained" | "Manual" {
  const professions = [...row.character.primary, ...row.character.secondary];
  if (["error", "unavailable"].includes(row.professionStatus))
    return professions.some((p) => p.recipes !== undefined)
      ? "Retained"
      : "Unknown";
  if (row.professionStatus === "manual") return "Manual";
  if (professions.every((p) => p.recipes !== undefined && !p.recipesRetained))
    return "Current";
  if (professions.length && professions.every((p) => p.recipesRetained))
    return "Retained";
  return professions.some((p) => p.recipes !== undefined)
    ? "Partial"
    : "Unknown";
}

export function recipeKnower({ row, status, fetchedAt }: RecipeKnower): string {
  const label = `${row.character.name}${row.discord ? ` — ${row.discord}` : " (Discord unmapped)"}`;
  if (status === "current") return label;
  if (status === "manual") return `${label} [manual]`;
  return `${label} [retained; last success: ${fetchedAt ?? "unknown"}]`;
}

// Excel's cell limit is 32,767 characters. Continue large knower lists on the
// next row instead of silently truncating or emitting an invalid workbook.
export function knowerChunks(rows: RecipeKnower[]): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const row of rows) {
    const line = recipeKnower(row);
    if (chunk && chunk.length + 1 + line.length > 30_000) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += `${chunk ? "\n" : ""}${line}`;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
