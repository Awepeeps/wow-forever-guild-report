import { SafeError } from "./http.ts";
import {
  itemIdSchema,
  regionSchema,
  slugSchema,
  spellIdSchema,
} from "./model.ts";

export const upstreamRepositoryUrl =
  "https://github.com/Awepeeps/wow-forever-guild-report";
export const upstreamIssuesUrl = `${upstreamRepositoryUrl}/issues`;

export function armoryUrl(region: string, slug: string): string {
  return `https://worldofwarcraft.blizzard.com/en-us/forever/${regionSchema.parse(region)}/armory/character/${encodeURIComponent(slugSchema.parse(slug))}`;
}

export function guildArmoryUrl(region: string, slug: string): string {
  return `https://worldofwarcraft.blizzard.com/en-us/forever/${regionSchema.parse(region)}/armory/guild/${encodeURIComponent(slugSchema.parse(slug))}`;
}

// Only a mapped Spell ID belongs here; a Blizzard recipe ID is a different ID space.
export function recipeUrl(spellId: number): string {
  return `https://www.wowhead.com/forever/spell=${spellIdSchema.parse(spellId)}`;
}

// Crafted items and reagents already carry item IDs; no recipe/spell mapping is used.
export function itemUrl(itemId: number): string {
  return `https://www.wowhead.com/forever/item=${itemIdSchema.parse(itemId)}`;
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
        ["character", "guild"].includes(parts[5] ?? "") &&
        slugSchema.safeParse(decodeURIComponent(parts[6] ?? "")).success
      )
        return;
    }
    if (
      url.hostname === "www.wowhead.com" &&
      !url.search &&
      /^\/forever\/(?:spell|item)=[1-9]\d{0,9}$/.test(url.pathname) &&
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

export interface ItemLinkList {
  row: number;
  column: number;
  items: { text: string; url: string }[];
}

// Entire material lines are linked. Deriving run offsets from this exact text
// avoids mismatched quantities/names and UTF-16 offsets for non-BMP names.
export function validatedItemLists(
  rows: readonly (readonly (string | number)[])[],
  lists: readonly ItemLinkList[] = [],
  links: readonly PublicLink[] = [],
): readonly ItemLinkList[] {
  const cells = new Set(links.map((link) => `${link.row}:${link.column}`));
  for (const list of lists) {
    const key = `${list.row}:${list.column}`;
    if (
      !Number.isInteger(list.row) ||
      list.row < 1 ||
      list.row >= rows.length ||
      !Number.isInteger(list.column) ||
      list.column < 0 ||
      list.column >= (rows[list.row]?.length ?? 0) ||
      ["Notes", "Player Notes (Editable)"].includes(
        String(rows[0]?.[list.column]),
      ) ||
      cells.has(key) ||
      !list.items.length ||
      list.items.length > 100 ||
      list.items.some((item) => !item.text.length) ||
      rows[list.row]?.[list.column] !==
        list.items.map((item) => item.text).join("\n")
    )
      throw new SafeError(
        "Workbook item links have an invalid, conflicting or mismatched cell.",
      );
    for (const item of list.items) {
      assertPublicLink(item.url);
      if (
        !/^https:\/\/www\.wowhead\.com\/forever\/item=[1-9]\d{0,9}$/.test(
          item.url,
        )
      )
        throw new SafeError(
          "Workbook material link must use a Wowhead Forever item ID.",
        );
    }
    cells.add(key);
  }
  return lists;
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
