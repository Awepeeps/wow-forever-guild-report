import { SafeError } from "./http.ts";
import { regionSchema, slugSchema, spellIdSchema } from "./model.ts";

export const upstreamRepositoryUrl =
  "https://github.com/Awepeeps/wow-forever-guild-report";
export const upstreamIssuesUrl = `${upstreamRepositoryUrl}/issues`;

export function armoryUrl(region: string, slug: string): string {
  return `https://worldofwarcraft.blizzard.com/en-us/forever/${regionSchema.parse(region)}/armory/character/${encodeURIComponent(slugSchema.parse(slug))}`;
}

// Only a mapped Spell ID belongs here; a Blizzard recipe ID is a different ID space.
export function recipeUrl(spellId: number): string {
  return `https://www.wowhead.com/forever/spell=${spellIdSchema.parse(spellId)}`;
}

export function assertPublicLink(value: string): void {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    )
      throw new Error();
    if (value === upstreamRepositoryUrl || value === upstreamIssuesUrl) return;
    if (url.hostname === "worldofwarcraft.blizzard.com" && !url.search) {
      const parts = url.pathname.split("/");
      if (
        parts.length === 7 &&
        parts[1] === "en-us" &&
        parts[2] === "forever" &&
        regionSchema.safeParse(parts[3]).success &&
        parts[4] === "armory" &&
        parts[5] === "character" &&
        slugSchema.safeParse(decodeURIComponent(parts[6] ?? "")).success
      )
        return;
    }
    if (
      url.hostname === "www.wowhead.com" &&
      !url.search &&
      /^\/forever\/spell=[1-9]\d{0,9}$/.test(url.pathname) &&
      spellIdSchema.safeParse(Number(url.pathname.split("=")[1])).success
    )
      return;
    if (
      url.hostname === "www.wowhead.com" &&
      url.pathname === "/forever/search" &&
      [...url.searchParams.keys()].length === 1 &&
      url.searchParams.getAll("q").length === 1 &&
      url.searchParams.has("q") &&
      (url.searchParams.get("q")?.trim().length ?? 0) > 0 &&
      (url.searchParams.get("q")?.length ?? 0) <= 200
    )
      return;
  } catch {
    // Never echo a rejected target: it could contain credentials or private data.
  }
  throw new SafeError(
    "Workbook hyperlink is not an allowed public Armory, Wowhead Forever, or upstream repository link.",
  );
}

export interface PublicLink {
  row: number;
  column: number;
  url: string;
}
export function validatedLinks(
  rows: readonly (readonly (string | number)[])[],
  links: readonly PublicLink[] = [],
): readonly PublicLink[] {
  const cells = new Set<string>();
  for (const link of links) {
    const key = `${link.row}:${link.column}`;
    if (
      !Number.isInteger(link.row) ||
      link.row < 1 ||
      link.row >= rows.length ||
      !Number.isInteger(link.column) ||
      link.column < 0 ||
      link.column >= (rows[link.row]?.length ?? 0) ||
      ["Notes", "Player Notes (Editable)"].includes(
        String(rows[0]?.[link.column]),
      ) ||
      cells.has(key)
    )
      throw new SafeError(
        "Workbook hyperlink has an invalid or duplicate cell location.",
      );
    assertPublicLink(link.url);
    cells.add(key);
  }
  return links;
}
