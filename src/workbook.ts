import { strToU8, zipSync } from "fflate";
import type { Profession, Snapshot } from "./model.ts";

export type Cell = string | number;
export interface Table {
  name: string;
  rows: Cell[][];
}

function skill(p: Profession): string {
  const value =
    p.skill === undefined
      ? "unknown"
      : `${p.skill}${p.max === undefined ? "" : `/${p.max}`}`;
  return p.tier ? `${p.tier}: ${value}` : value;
}

export function buildTables(snapshot: Snapshot): Table[] {
  const characters: Cell[][] = [
    [
      "Discord",
      "Character Name",
      "Ruleset",
      "Class",
      "Faction",
      "Race",
      "Level",
      "Guild Rank",
      "Talent Points",
      "Profession 1",
      "Profession 2",
      "Notes",
      "Profession 1 Levels",
      "Profession 2 Levels",
      "Secondary Professions & Levels",
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
      "Generated At",
      "Sync Notes",
    ],
  ];
  const professions: Cell[][] = [
    [
      "Discord",
      "Character Name",
      "Category",
      "Profession",
      "Tier",
      "Skill",
      "Maximum",
      "Status",
      "Character Slug",
    ],
  ];
  for (const row of snapshot.rows) {
    const c = row.character;
    const names = [...new Set(c.primary.map((p) => p.name))];
    characters.push([
      row.discord,
      c.name,
      c.ruleset,
      c.class,
      c.faction,
      c.race,
      c.level ?? "",
      c.guildRank ?? "",
      c.talents
        .map(
          (t) => `${t.group ? `Group ${t.group}: ` : ""}${t.tree} ${t.points}`,
        )
        .join(", "),
      names[0] ?? "",
      names[1] ?? "",
      "",
      c.primary
        .filter((p) => p.name === names[0])
        .map(skill)
        .join("; "),
      c.primary
        .filter((p) => p.name === names[1])
        .map(skill)
        .join("; "),
      c.secondary.map((p) => `${p.name}: ${skill(p)}`).join("; "),
      snapshot.region,
      c.slug,
      c.id ?? "",
      row.profileStatus,
      row.professionStatus,
      row.talentStatus,
      row.fetchedAt ?? "",
      row.profileFetchedAt ?? "",
      row.professionFetchedAt ?? "",
      row.talentFetchedAt ?? "",
      snapshot.generatedAt,
      row.issue.trim(),
    ]);
    for (const [category, list] of [
      ["Primary", c.primary],
      ["Secondary", c.secondary],
    ] as const) {
      for (const p of list)
        professions.push([
          row.discord,
          c.name,
          category,
          p.name,
          p.tier ?? "",
          p.skill ?? "",
          p.max ?? "",
          row.professionStatus,
          c.slug,
        ]);
    }
  }
  const guild: Cell[][] = [
    ["Metric", "Value"],
    ["Guild", snapshot.guild ?? "Explicit character roster"],
    ["Region", snapshot.region],
    ["Generated At", snapshot.generatedAt],
    ["Characters", snapshot.rows.length],
    ["Discord Mapped", snapshot.rows.filter((r) => r.discord).length],
    [
      "API Profile Errors / Unavailable",
      snapshot.rows.filter((r) =>
        ["error", "unavailable"].includes(r.profileStatus),
      ).length,
    ],
    [
      "API Profession Errors / Unavailable",
      snapshot.rows.filter((r) =>
        ["error", "unavailable"].includes(r.professionStatus),
      ).length,
    ],
  ];
  for (const field of ["class", "faction", "ruleset"] as const) {
    const counts = new Map<string, number>();
    for (const r of snapshot.rows) {
      const label = r.character[field] || "Unknown";
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    for (const [label, count] of [...counts].sort(([a], [b]) =>
      a.localeCompare(b),
    ))
      guild.push([`${field}: ${label}`, count]);
  }
  const reference: Cell[][] = [
    ["Topic", "Details"],
    [
      "Identity",
      "WoW Forever: region + stable character ID, falling back to the realmless first-name–surname slug when no ID is available. Rulesets are not realms.",
    ],
    [
      "Levels",
      "Unknown skill is blank/unknown, never zero. Each returned profession tier is retained in Professions.",
    ],
    [
      "Secondaries",
      "All API-returned secondaries, including Cooking, Fishing, and First Aid where supported.",
    ],
    [
      "Manual fields",
      "Discord names come from a private JSON map. Notes are human-owned in Google Sheets and are never imported from CSV or API.",
    ],
    [
      "Availability",
      "Launch-week API is undocumented. A 404 does not prove a character or profession is absent. Low-level/unpublished profiles may be unavailable.",
    ],
    [
      "Freshness",
      "Fetched At is request time, not in-game update time. Blizzard may serve delayed data.",
    ],
    ["Provider", "https://develop.battle.net/documentation/world-of-warcraft"],
    [
      "Guild rank",
      "Numeric API rank: 0 is guild master. Custom rank names are not inferred.",
    ],
    [
      "Talents",
      "Point spend in each tree in the active talent group; no inferred role/spec label.",
    ],
    [
      "Forever API research (community; US routes verified 2026-11-07)",
      "https://us.forums.blizzard.com/en/blizzard/t/wow-forever-api-what-works-so-far-plus-a-ts-client/60334",
    ],
  ];
  return [
    { name: "Characters", rows: characters },
    { name: "Guild Info", rows: guild },
    { name: "Professions", rows: professions },
    { name: "Data Notes", rows: reference },
  ];
}

export function toCsv(rows: Cell[][]): string {
  return `${rows
    .map((row) =>
      row
        .map((cell) => {
          let value = String(cell);
          if (typeof cell === "string" && /^[\s\uFEFF]*[=+@-]/u.test(value))
            value = `'${value}`;
          if (typeof cell === "string" && /^[\t\r\n]/u.test(value))
            value = `'${value}`;
          return `"${value.replaceAll('"', '""')}"`;
        })
        .join(","),
    )
    .join("\r\n")}\r\n`;
}

function xml(value: Cell): string {
  return (
    String(value)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: XML 1.0 forbids these input characters.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;")
  );
}
function column(index: number): string {
  let result = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  return result;
}

// A small OOXML writer: inline strings avoid formulas and external links entirely.
export function toXlsx(tables: Table[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const add = (path: string, body: string) => {
    files[path] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`,
    );
  };
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const relns = "http://schemas.openxmlformats.org/package/2006/relationships";
  add(
    "[Content_Types].xml",
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${tables.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
  );
  add(
    "_rels/.rels",
    `<Relationships xmlns="${relns}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  add(
    "xl/workbook.xml",
    `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${tables.map((t, i) => `<sheet name="${xml(t.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
  );
  add(
    "xl/_rels/workbook.xml.rels",
    `<Relationships xmlns="${relns}">${tables.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  add(
    "xl/styles.xml",
    `<styleSheet xmlns="${ns}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF173B53"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  );
  tables.forEach((table, i) => {
    const width = table.rows[0]?.length ?? 1;
    const last = `${column(width - 1)}${Math.max(1, table.rows.length)}`;
    const rows = table.rows
      .map(
        (row, r) =>
          `<row r="${r + 1}"${r === 0 ? ' ht="32" customHeight="1"' : ""}>${row.map((cell, c) => `<c r="${column(c)}${r + 1}" s="${r === 0 ? 1 : 0}" t="${typeof cell === "number" ? "n" : "inlineStr"}">${typeof cell === "number" ? `<v>${cell}</v>` : `<is><t xml:space="preserve">${xml(cell)}</t></is>`}</c>`).join("")}</row>`,
      )
      .join("");
    add(
      `xl/worksheets/sheet${i + 1}.xml`,
      `<worksheet xmlns="${ns}"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="${width}" width="24" customWidth="1"/></cols><sheetData>${rows}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`,
    );
  });
  return zipSync(files, { level: 6 });
}
