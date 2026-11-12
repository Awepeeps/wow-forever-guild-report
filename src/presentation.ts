import type { RosterRow } from "./model.ts";

const classColors: Record<string, string> = {
  warrior: "C79C6E",
  paladin: "F58CBA",
  hunter: "ABD473",
  rogue: "FFF569",
  priest: "EDF0F5",
  "death knight": "C41F3B",
  shaman: "0070DE",
  mage: "69CCF0",
  warlock: "9482C9",
  monk: "00FF96",
  druid: "FF7D0A",
  "demon hunter": "A330C9",
  evoker: "33937F",
};

export type DisplayApiStatus =
  | "Complete"
  | "Unavailable"
  | "Incomplete"
  | "Manual";
export function displayApiStatus(
  statuses: readonly ("manual" | "ok" | "unavailable" | "error")[],
  retained = false,
): DisplayApiStatus {
  if (statuses.length && statuses.every((s) => s === "manual")) return "Manual";
  if (retained) return "Incomplete";
  if (statuses.length && statuses.every((s) => s === "unavailable"))
    return "Unavailable";
  return statuses.length && statuses.every((s) => s === "ok") && !retained
    ? "Complete"
    : "Incomplete";
}

export const playerNotesHeader = "Player Notes (Editable)";
export function apiDetails(
  row: RosterRow,
  scope: "character" | "profession",
): string {
  const components =
    scope === "character"
      ? [
          ["Profile", row.profileStatus],
          ["Talents", row.talentStatus],
        ]
      : [["Professions", row.professionStatus]];
  const details = components.flatMap(([name, status]) =>
    status === "unavailable"
      ? [`${name}: unavailable (404)`]
      : status === "error"
        ? [`${name}: request or response validation failed`]
        : [],
  );
  if (
    scope === "profession" &&
    row.professionStatus === "ok" &&
    [...row.character.primary, ...row.character.secondary].some(
      (p) => p.recipesRetained,
    )
  )
    details.push("Recipe list omitted; prior knowledge retained");
  return details.join("; ");
}
export function exportHeader(
  table: string,
  header: string | number,
): string | number {
  return table === "Characters" && header === "Last Login"
    ? "Last Login (at export)"
    : header;
}
export function isPlayerNotesHeader(header: unknown): boolean {
  return header === playerNotesHeader || header === "Notes";
}

// Empty Discord mappings identify separate characters, never a shared player.
export function playerGroups(
  rows: readonly (readonly (string | number)[])[],
): { start: number; end: number; shaded: boolean }[] {
  const groups: { start: number; end: number; shaded: boolean }[] = [];
  let previous: string | number | undefined;
  for (let i = 1; i < rows.length; i++) {
    const discord = rows[i]?.[0];
    const group = groups.at(-1);
    if (group && discord && discord === previous) group.end = i + 1;
    else groups.push({ start: i, end: i + 1, shaded: groups.length % 2 === 0 });
    previous = discord;
  }
  return groups;
}

/** Readable profit/loss emphasis; the signed text stays the primary signal. */
export const toneStyles = {
  gain: { background: "E6F4EA", foreground: "137333" },
  loss: { background: "FCE8E6", foreground: "A50E0E" },
} as const;

export function classStyle(name: string): {
  background: string;
  foreground: string;
} {
  const key = name.trim().toLowerCase();
  const background =
    (Object.hasOwn(classColors, key) ? classColors[key] : undefined) ??
    "E5E7EB";
  const channels = [0, 2, 4].map((offset) => {
    const value =
      Number.parseInt(background.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    (channels[0] ?? 0) * 0.2126 +
    (channels[1] ?? 0) * 0.7152 +
    (channels[2] ?? 0) * 0.0722;
  return {
    background,
    foreground:
      (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05)
        ? "000000"
        : "FFFFFF",
  };
}

export function columnPresentation(
  table: string,
  header: string,
): { width: number; hidden: boolean } {
  const technical = new Set([
    "Region",
    "Character Slug",
    "Character ID",
    "Profile Status",
    "Professions Status",
    "Talents Status",
    "Fetched At",
    "Profile Last Success",
    "Professions Last Success",
    "Talents Last Success",
    "Sync Notes",
    "Generated At",
    "Guild Rank Number",
    "Recipe Coverage",
    "Recipe ID",
    "Wowhead Spell ID",
    "Recipe URL",
    "Armory URL",
    "Average ilvl",
    "Last Login (UTC)",
    "Recipe Details Last Success",
    "Recipe Details Last Attempt",
    "Output Item ID",
    "Output Minimum",
    "Output Maximum",
    "Makes URL",
    "Materials URLs",
    "Output AH Copper",
    "Materials AH Copper",
    "AH Margin Copper",
    "Auction House ID",
    "Auction Last Success",
    "Auction Last Attempt",
    "Auctions Updated (UTC)",
    "Commodities Updated (UTC)",
    "Hyjal URL",
  ]);
  const hidden =
    technical.has(header) ||
    (table === "Characters" && ["Ruleset", "Faction", "Race"].includes(header));
  const widths: Record<string, number> = {
    Discord: 130,
    "Character Name": 170,
    Class: 100,
    Level: 75,
    "Guild Rank": 110,
    iLvl: 85,
    "Last Login": 110,
    "Last Login (at export)": 155,
    "Achievement Points": 110,
    "Talent Points": 190,
    [playerNotesHeader]: 200,
    "Character API Status": 120,
    "Generated At": 165,
    "Primary Professions": 230,
    "Secondary Professions": 250,
    "Profession API Status": 120,
    Profession: 160,
    Recipe: 240,
    "Known By": 460,
    "Knower Data": 160,
    Makes: 230,
    "Materials per Craft": 280,
    "Recipe Details": 170,
    "Output AH / Item": 150,
    "Output Listed": 100,
    "Hyjal AH": 120,
    "Materials AH / Craft": 180,
    "AH Margin / Craft": 170,
    "AH Data": 200,
    "AH Snapshot (UTC)": 185,
    "API Details": 260,
    Topic: 220,
    Details: 720,
    Metric: 300,
    Value: 300,
  };
  return {
    width: /^Material \d+$/.test(header)
      ? 240
      : ((Object.hasOwn(widths, header) ? widths[header] : undefined) ?? 180),
    hidden,
  };
}

export function rgb(hex: string): { red: number; green: number; blue: number } {
  return {
    red: Number.parseInt(hex.slice(0, 2), 16) / 255,
    green: Number.parseInt(hex.slice(2, 4), 16) / 255,
    blue: Number.parseInt(hex.slice(4, 6), 16) / 255,
  };
}
