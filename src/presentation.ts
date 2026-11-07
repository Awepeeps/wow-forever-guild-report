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
  ]);
  const hidden =
    technical.has(header) ||
    (table === "Characters" && ["Ruleset", "Faction", "Race"].includes(header));
  const widths: Record<string, number> = {
    Discord: 130,
    "Character Name": 170,
    Class: 100,
    Level: 55,
    "Guild Rank": 70,
    "Talent Points": 190,
    Notes: 200,
    "API Status": 110,
    "Generated At": 165,
    Profession: 150,
    Category: 100,
    Tier: 130,
    Skill: 65,
    Maximum: 80,
    "Profession API Status": 150,
    Topic: 220,
    Details: 720,
    Metric: 300,
    Value: 300,
  };
  return {
    width: (Object.hasOwn(widths, header) ? widths[header] : undefined) ?? 180,
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
