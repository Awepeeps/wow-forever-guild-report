import { parse } from "csv-parse/sync";
import { SafeError } from "./http.ts";
import { characterSlug, configSchema, type RosterConfig } from "./model.ts";

const expected = [
  "Discord",
  "Character Name",
  "Ruleset",
  "Class",
  "Faction",
  "Race",
  "Level",
  "Spec 1",
  "Spec 2",
  "Profession 1",
  "Profession 2",
  "Notes",
];

export function importCsv(
  csv: string,
  region: RosterConfig["region"] = "us",
): { config: RosterConfig; discord: Record<string, string> } {
  let records: Record<string, string>[];
  try {
    records = parse(csv, {
      bom: true,
      columns(headers: string[]) {
        if (!expected.every((h) => headers.includes(h)))
          throw new Error("headers");
        if (new Set(headers).size !== headers.length)
          throw new Error("duplicate headers");
        return headers;
      },
      skip_empty_lines: true,
      trim: true,
      max_record_size: 100_000,
    });
  } catch {
    throw new SafeError(
      "CSV must contain the original 12 roster headers and valid quoted records.",
    );
  }
  const discord: Record<string, string> = Object.create(null);
  const characters = [];
  for (const [i, r] of records.entries()) {
    if (Object.values(r).every((v) => !v.trim())) continue;
    if (!r["Character Name"]?.trim())
      throw new SafeError(`CSV row ${i + 2} has data but no character name.`);
    let slug: string;
    try {
      slug = characterSlug(r["Character Name"]);
    } catch {
      throw new SafeError(
        `CSV row ${i + 2} has an invalid character name; supply an explicit API slug in JSON.`,
      );
    }
    if (r.Discord) discord[`${region}:${slug}`] = r.Discord;
    characters.push({
      slug,
      name: r["Character Name"],
      ruleset: r.Ruleset ?? "",
      class: r.Class ?? "",
      faction: r.Faction ?? "",
      race: r.Race ?? "",
      ...(r.Level ? { level: Number(r.Level) } : {}),
      talents: [],
      primary: [r["Profession 1"], r["Profession 2"]]
        .filter(Boolean)
        .map((name) => ({ name })),
      secondary: [],
    });
  }
  const result = configSchema.safeParse({ version: 1, region, characters });
  if (!result.success)
    throw new SafeError(
      "CSV contains invalid levels, duplicate identities, or values beyond roster limits.",
    );
  return { config: result.data, discord };
}
