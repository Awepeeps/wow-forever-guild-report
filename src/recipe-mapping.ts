import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { type Fetch, SafeError } from "./http.ts";
import {
  foreverBuildSchema,
  type RecipeMapping,
  recipeMappingSchema,
  type Snapshot,
} from "./model.ts";

const maxBytes = 2_000_000;

export function recipeMappingFromCsv(
  csv: string,
  build: string,
  fetchedAt = new Date().toISOString(),
): RecipeMapping {
  try {
    if (Buffer.byteLength(csv) > maxBytes) throw new Error();
    const rows: unknown = parse(csv, { bom: true, skip_empty_lines: true });
    if (!Array.isArray(rows) || rows.length < 2 || rows.length > 20_001)
      throw new Error();
    const [header, ...body]: unknown[] = rows;
    if (!Array.isArray(header)) throw new Error();
    if (
      header.filter((h) => h === "ID").length !== 1 ||
      header.filter((h) => h === "Spell").length !== 1
    )
      throw new Error();
    const idColumn = header.indexOf("ID"),
      spellColumn = header.indexOf("Spell");
    const spells: Record<string, number> = {};
    const seen = new Set<string>();
    for (const row of body) {
      if (!Array.isArray(row) || row.length !== header.length)
        throw new Error();
      const id: unknown = row[idColumn],
        spell: unknown = row[spellColumn];
      if (
        typeof id !== "string" ||
        !/^[1-9]\d{0,9}$/.test(id) ||
        typeof spell !== "string" ||
        !/^\d{1,10}$/.test(spell) ||
        seen.has(id)
      )
        throw new Error();
      seen.add(id);
      const spellId = Number(spell);
      if (spellId > 0) spells[id] = spellId;
    }
    if (!Object.keys(spells).length) throw new Error();
    return recipeMappingSchema.parse({
      build,
      source: "wago.tools/SkillLineAbility",
      sha256: createHash("sha256").update(csv).digest("hex"),
      fetchedAt,
      spells,
    });
  } catch {
    throw new SafeError(
      "Unsupported recipe mapping table or Forever build. No mapping was imported.",
    );
  }
}

// A separate, explicit setup operation. Refresh/export never query third-party
// services or follow response URLs; the validated map travels in the snapshot.
export async function downloadRecipeMapping(
  build: string,
  fetcher: Fetch = fetch,
): Promise<RecipeMapping> {
  if (!foreverBuildSchema.safeParse(build).success)
    throw new SafeError("Invalid Forever client build for recipe mapping.");
  try {
    const response = await fetcher(
      `https://wago.tools/db2/SkillLineAbility/csv?build=${build}&format=csv`,
      { redirect: "error", signal: AbortSignal.timeout(20_000) },
    );
    if (!response.ok || !response.body) throw new Error();
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > maxBytes) throw new Error();
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return recipeMappingFromCsv(Buffer.concat(chunks).toString("utf8"), build);
  } catch {
    throw new SafeError(
      "Recipe mapping download or validation failed. Existing mapping was not changed.",
    );
  }
}

export function withRecipeMapping(
  snapshot: Snapshot,
  mapping: RecipeMapping,
): Snapshot {
  // Keep the full pinned table so later refreshes can resolve newly learned
  // recipes without another network request or a list of special cases.
  return { ...snapshot, recipeMapping: recipeMappingSchema.parse(mapping) };
}
