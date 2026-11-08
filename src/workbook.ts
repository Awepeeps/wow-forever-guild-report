import { strToU8, zipSync } from "fflate";
import {
  craftingMaterials,
  craftingOutput,
  recipeDetailStatus,
} from "./crafting.ts";
import {
  type RelativeDate,
  relativeLogin,
  validatedRelativeDates,
} from "./dates.ts";
import {
  armoryUrl,
  type ItemLinkList,
  itemUrl,
  type PublicLink,
  recipeUrl,
  upstreamIssuesUrl,
  upstreamRepositoryUrl,
  validatedItemLists,
  validatedLinks,
} from "./links.ts";
import {
  hasRetainedRecipes,
  type Profession,
  type Snapshot,
  sortRows,
} from "./model.ts";
import {
  apiDetails,
  classStyle,
  columnPresentation,
  displayApiStatus,
  exportHeader,
  playerGroups,
  playerNotesHeader,
} from "./presentation.ts";
import { knowerChunks, knownRecipes, recipeCoverage } from "./recipes.ts";

export type Cell = string | number;
export interface Table {
  name: string;
  rows: Cell[][];
  links?: PublicLink[];
  itemLists?: ItemLinkList[];
  relativeDates?: RelativeDate[];
}

export function buildTables(snapshot: Snapshot): Table[] {
  const characters: Cell[][] = [
    [
      "Discord",
      "Character Name",
      "Guild Rank",
      "Class",
      "Level",
      "Talent Points",
      "Achievement Points",
      "iLvl",
      "Last Login",
      "Character API Status",
      playerNotesHeader,
      "API Details",
      "Average ilvl",
      "Last Login (UTC)",
      "Generated At",
      "Ruleset",
      "Faction",
      "Race",
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
      "Guild Rank Number",
      "Armory URL",
    ],
  ];
  const professions: Cell[][] = [
    [
      "Discord",
      "Character Name",
      "Class",
      "Primary Professions",
      "Secondary Professions",
      "Profession API Status",
      playerNotesHeader,
      "API Details",
      "Generated At",
      "Professions Last Success",
      "Recipe Coverage",
      "Region",
      "Character Slug",
      "Character ID",
      "Armory URL",
    ],
  ];
  for (const row of sortRows([...snapshot.rows])) {
    const c = row.character;
    const failed = (status: string) =>
      status === "unavailable" || status === "error";
    const characterRetained =
      (failed(row.profileStatus) &&
        (row.profileFetchedAt !== null ||
          [c.class, c.race, c.faction, c.ruleset].some(Boolean) ||
          [
            c.level,
            c.equippedItemLevel,
            c.averageItemLevel,
            c.achievementPoints,
            c.lastLoginAt,
          ].some((v) => v !== undefined))) ||
      (failed(row.talentStatus) &&
        (row.talentFetchedAt !== null || c.talents.length > 0));
    characters.push([
      row.discord,
      c.name,
      c.guildRank === undefined
        ? ""
        : (snapshot.guildRankNames[String(c.guildRank)] ??
          `Rank ${c.guildRank} (unmapped)`),
      c.class,
      c.level ?? "",
      c.talents
        .map(
          (t) => `${t.group ? `Group ${t.group}: ` : ""}${t.tree} ${t.points}`,
        )
        .join(", "),
      c.achievementPoints ?? "",
      c.equippedItemLevel ?? "",
      c.lastLoginAt ? relativeLogin(c.lastLoginAt, snapshot.generatedAt) : "",
      displayApiStatus(
        [row.profileStatus, row.talentStatus],
        characterRetained,
      ),
      "",
      apiDetails(row, "character"),
      c.averageItemLevel ?? "",
      c.lastLoginAt ?? "",
      snapshot.generatedAt,
      c.ruleset,
      c.faction,
      c.race,
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
      row.issue.trim(),
      c.guildRank ?? "",
      armoryUrl(snapshot.region, c.slug),
    ]);
    const describe = (list: Profession[]) =>
      list.length
        ? list
            .map((p) => {
              const tier =
                p.tier &&
                p.tier.toLocaleLowerCase("en-US") !==
                  p.name.toLocaleLowerCase("en-US")
                  ? ` (${p.tier})`
                  : "";
              return `${p.name}${tier} — ${p.skill ?? "?"}/${p.max ?? "?"}`;
            })
            .join("\n")
        : ["error", "unavailable"].includes(row.professionStatus)
          ? "Unavailable"
          : "None reported";
    professions.push([
      row.discord,
      c.name,
      c.class,
      describe(c.primary),
      describe(c.secondary),
      displayApiStatus(
        [row.professionStatus],
        hasRetainedRecipes(c) ||
          (failed(row.professionStatus) &&
            (c.primary.length > 0 || c.secondary.length > 0)),
      ),
      "",
      apiDetails(row, "profession"),
      snapshot.generatedAt,
      row.professionFetchedAt ?? "",
      recipeCoverage(row),
      snapshot.region,
      c.slug,
      c.id ?? "",
      armoryUrl(snapshot.region, c.slug),
    ]);
  }
  const recipeEntries = knownRecipes(snapshot);
  const recipeItemLists: ItemLinkList[] = [];
  const craftedItemLinks: PublicLink[] = [];
  const recipes: Cell[][] = [
    [
      "Profession",
      "Recipe",
      "Makes",
      "Materials per Craft",
      "Known By",
      "Recipe Details",
      "Knower Data",
      "Recipe ID",
      "Generated At",
      "Wowhead Link",
      "Wowhead Spell ID",
      "Recipe Details Last Success",
      "Recipe Details Last Attempt",
      "Output Item ID",
      "Output Minimum",
      "Output Maximum",
      "Makes URL",
      "Materials URLs",
      "Recipe URL",
    ],
  ];
  for (const recipe of recipeEntries) {
    const spellId = snapshot.recipeMapping?.spells[String(recipe.id)];
    const details = snapshot.recipeDetails?.[String(recipe.id)];
    const status = recipe.knowers.some((r) => r.status === "retained")
      ? "Includes retained data"
      : recipe.knowers.some((r) => r.status === "manual")
        ? "Includes manual data"
        : "Current reports";
    for (const chunk of knowerChunks(recipe.knowers)) {
      const row = recipes.length;
      const output = details?.data?.output;
      const materials =
        details?.data?.reagents?.map((r) => ({
          text: `${r.quantity} × ${r.item.name}`,
          url: itemUrl(r.item.id),
        })) ?? [];
      if (output)
        craftedItemLinks.push({ row, column: 2, url: itemUrl(output.id) });
      if (materials.length)
        recipeItemLists.push({ row, column: 3, items: materials });
      recipes.push([
        recipe.profession,
        recipe.name,
        craftingOutput(details?.data),
        craftingMaterials(details?.data),
        chunk,
        recipeDetailStatus(details),
        status,
        recipe.id,
        snapshot.generatedAt,
        spellId === undefined ? "Unmapped — update recipe map" : "Exact spell",
        spellId ?? "",
        details?.fetchedAt ?? "",
        details?.attemptedAt ?? "",
        details?.data?.output?.id ?? "",
        details?.data?.quantity?.min ?? "",
        details?.data?.quantity?.max ?? "",
        output ? itemUrl(output.id) : "",
        materials.map((item) => item.url).join("\n"),
        spellId === undefined ? "" : recipeUrl(spellId),
      ]);
    }
  }
  const guild: Cell[][] = [
    ["Metric", "Value"],
    ["Guild", snapshot.guild ?? "Explicit character roster"],
    ["Region", snapshot.region],
    ["Generated At", snapshot.generatedAt],
    [
      "Last Refresh (local)",
      new Intl.DateTimeFormat("en-US", {
        timeZone: snapshot.reportTimeZone,
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(snapshot.generatedAt)),
    ],
    ["Report Timezone", snapshot.reportTimeZone],
    ["Characters", snapshot.rows.length],
    [
      "Character API Coverage (complete / characters)",
      `${characters.slice(1).filter((row) => row[characters[0]?.indexOf("Character API Status") ?? -1] === "Complete").length} / ${snapshot.rows.length}`,
    ],
    [
      "Profession API Coverage (complete / characters)",
      `${professions.slice(1).filter((row) => row[professions[0]?.indexOf("Profession API Status") ?? -1] === "Complete").length} / ${snapshot.rows.length}`,
    ],
    [
      "Recipe Coverage (current / characters)",
      `${snapshot.rows.filter((r) => recipeCoverage(r) === "Current").length} / ${snapshot.rows.length}`,
    ],
    ["Discord Mapped", snapshot.rows.filter((r) => r.discord).length],
    ["Known Recipes (distinct profession + ID)", recipeEntries.length],
    [
      "Recipe Detail Responses (successful / recipes)",
      `${recipeEntries.filter((r) => snapshot.recipeDetails?.[String(r.id)]?.status === "ok").length} / ${recipeEntries.length}`,
    ],
    [
      "Recipe Details (complete / recipes)",
      `${recipeEntries.filter((r) => recipeDetailStatus(snapshot.recipeDetails?.[String(r.id)]) === "Available").length} / ${recipeEntries.length}`,
    ],
    [
      "Recipe Details Source",
      `Blizzard static-forever-${snapshot.region} recipe API`,
    ],
    [
      "Auction Prices",
      "Disabled — the guild's Roleplay auction house has not been verified. No prices from other markets are substituted.",
    ],
    [
      "Wowhead Exact Recipe Links",
      recipeEntries.filter(
        (r) => snapshot.recipeMapping?.spells[String(r.id)] !== undefined,
      ).length,
    ],
    ["Recipe Mapping Build", snapshot.recipeMapping?.build ?? "Not loaded"],
    [
      "Recipe Mapping Source",
      snapshot.recipeMapping ? snapshot.recipeMapping.source : "Not loaded",
    ],
    ["Recipe Mapping SHA-256", snapshot.recipeMapping?.sha256 ?? ""],
    ["Recipe Mapping Fetched At", snapshot.recipeMapping?.fetchedAt ?? ""],
    [
      "Recipe Coverage",
      "Only API-returned knowledge is listed; missing or retained data is not proof that nobody knows a recipe. See Professions' hidden Recipe Coverage column.",
    ],
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
    ["Source code (upstream)", upstreamRepositoryUrl],
    ["Report a problem", upstreamIssuesUrl],
    [
      "Refreshing this workbook",
      "Run just refresh with the private guild config and output directory to refresh local exports; exit 2 means partial data was retained. Publishing to Google Sheets is a separate, explicitly requested just sheets step. Check Guild Info for last refresh and API coverage. Do not attach private rosters, notes, credentials or exports to a public issue.",
    ],
    [
      "Layout",
      "Characters is the roster overview; Professions has one row per character with primary/secondary skills and tiers in separate cells. Both sort by numeric guild rank, Discord, then character name. Shading marks contiguous player groups; rank-first order can split one player's characters across ranks. Guild Info shows the export timestamp. Technical identity, status, generation and last-success columns are hidden by default and can be unhidden. CSV files include all columns.",
    ],
    [
      "Class colors",
      "Class cells use recognizable WoW colors with contrasting text; Priest uses light gray. Class names remain visible, so color is not the only identifier.",
    ],
    [
      "API status",
      "Character API Status covers profile/talents; Profession API Status covers professions/recipes. Both use Complete, Unavailable, Incomplete, Manual. Complete means all relevant requests succeeded. Unavailable means 404s with no retained detail; Incomplete means mixed/error responses or retained data, which may be older than this export. API Details explains failed components without changing the status vocabulary. Unhide component statuses and last-success columns for timestamps.",
    ],
    [
      "Identity",
      "WoW Forever: region + stable character ID, falling back to the realmless first-name–surname slug when no ID is available. Rulesets are not realms.",
    ],
    [
      "Levels",
      "Profession cells show skill/maximum; ? means unknown, never zero. Each returned profession tier is retained on its own line in Professions.",
    ],
    [
      "Secondaries",
      "All API-returned secondaries, including Cooking, Fishing, and First Aid where supported.",
    ],
    [
      "Manual fields",
      "Discord names come from a private JSON map. Player Notes (Editable) is human-owned on Characters and Professions. Each tab keeps its own notes by character identity; notes are never imported from CSV, config or API.",
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
      "Guild rank labels come from the private guildRankNames mapping. Unmapped ranks are labelled explicitly; the numeric API rank remains in a hidden column. Custom titles are never inferred.",
    ],
    [
      "Talents",
      "Point spend in each tree in the active talent group; no inferred role/spec label.",
    ],
    [
      "Character metrics",
      "iLvl is equipped item level; Average ilvl is hidden. Blank means unknown. A successful profile omitting a metric clears it; a failed profile retains prior values and last-success time. Sheets Last Login requires the validated en_US spreadsheet locale and shows Today/1 day ago/N days ago with a trusted DATE/TODAY formula in the spreadsheet timezone; unsupported locales stop before writing. Hourly-or-faster recalculation keeps the age current. The exact Blizzard UTC timestamp is hidden and can lag. XLSX/CSV Last Login (at export) is static at Generated At, using UTC calendar dates. Age recalculation does not fetch new Blizzard data.",
    ],
    [
      "Recipes",
      "Recipes lists profession, recipe and known characters (with Discord), sorted by profession then recipe. Knower Data describes only the listed knowers, not guild-wide coverage. IDs distinguish recipes with the same name. Duplicate tiers do not repeat a knower. Failed profession requests retain known recipes with per-character last-success labels. Successful responses omitting recipe lists retain only the same profession/tier knowledge and its original recipe-specific timestamp; explicit empty lists clear it. Missing recipe arrays mean unknown coverage; empty arrays mean no recipes reported for that tier. A successful response with no professions counts as current empty knowledge. Large knower lists continue on the next row; XLSX row heights are capped, so inspect the full cell text for unusually long lists. This is a knowledge index, not a catalogue of recipes nobody knows.",
    ],
    [
      "Recipe materials and output",
      "Makes and Materials per Craft come from Blizzard's static-forever recipe-detail endpoint, using the original recipe ID. All returned materials and quantities are preserved; ? and Unknown mean unreported, never zero. Details are cached privately for 24 hours and refreshed after a mapping-build change. Failed requests retain prior details and their original last-success time, with a visible Retained label; missing fields on successful responses become unknown. Recipe Details reports metadata availability independently of who knows it. Unhide last-success, last-attempt and output IDs/quantities for diagnostics. No vendor substitutions or Classic/Retail fallbacks are used.",
    ],
    [
      "Crafted item and material links",
      "Makes opens the crafted item's exact Wowhead Forever item page. Each material line opens its own item page, using the item IDs returned with crafting details. Unknown details stay unlinked. Google Sheets keeps the multiline materials cell; XLSX uses separate linked Material columns when multiple ingredients are present. CSV includes Makes URL and Materials URLs in the same order as the materials. Recipe names still open the crafting spell page.",
    ],
    [
      "Auction prices",
      "Price estimates are disabled until the guild's exact auction house is verified. The Forever API lists multiple identically named houses and does not reliably identify their ruleset. Materials/output remain useful without prices; unknown prices are not treated as zero.",
    ],
    [
      "Public links",
      "Character names open the official realmless Forever Armory (talents are on the main character page). Recipe names open exact Wowhead Forever crafting spell pages using a build-pinned SkillLineAbility.ID → Spell table from wago.tools. Blizzard recipe IDs are never treated as spell IDs or matched by name. Unmapped recipes have no link and are labelled for a mapping update; no search links are substituted. Guild Info records the mapping build, source hash and fetch time. Hidden spell-ID/URL columns keep targets in CSV. Source code (upstream) links to the public GitHub repository that generates this export; Report a problem opens its issues page. Hyperlinks are restricted to the approved HTTPS Armory/Wowhead routes and those exact repository/issues links; arbitrary API URLs are never emitted. Only Sheets Last Login uses the fixed generated relative-date formula; raw data stays literal.",
    ],
    [
      "Forever API research (community; US routes verified 2026-11-07)",
      "https://us.forums.blizzard.com/en/blizzard/t/wow-forever-api-what-works-so-far-plus-a-ts-client/60334",
    ],
  ];
  return [
    {
      name: "Characters",
      rows: characters,
      relativeDates: characters.slice(1).flatMap((row, i) => {
        const timestamp = row[characters[0]?.indexOf("Last Login (UTC)") ?? -1];
        return timestamp
          ? [
              {
                row: i + 1,
                column: characters[0]?.indexOf("Last Login") ?? -1,
                timestamp: String(timestamp),
              },
            ]
          : [];
      }),
      links: characters
        .slice(1)
        .map((row, i) => ({ row: i + 1, column: 1, url: String(row.at(-1)) })),
    },
    {
      name: "Professions",
      rows: professions,
      links: professions
        .slice(1)
        .map((row, i) => ({ row: i + 1, column: 1, url: String(row.at(-1)) })),
    },
    {
      name: "Recipes",
      rows: recipes,
      itemLists: recipeItemLists,
      links: [
        ...recipes
          .slice(1)
          .flatMap((row, i) =>
            row.at(-1)
              ? [{ row: i + 1, column: 1, url: String(row.at(-1)) }]
              : [],
          ),
        ...craftedItemLinks,
      ],
    },
    { name: "Guild Info", rows: guild },
    {
      name: "Automated Export Info",
      rows: reference,
      links: [
        { row: 1, column: 1, url: upstreamRepositoryUrl },
        { row: 2, column: 1, url: upstreamIssuesUrl },
      ],
    },
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

function professionRowHeight(table: Table, row: Cell[]): number {
  const lines = row.map((cell, c) => {
    const presentation = columnPresentation(
      table.name,
      String(table.rows[0]?.[c] ?? ""),
    );
    if (presentation.hidden) return 0;
    // Allow for padding and wrapped text as well as explicit line breaks.
    const capacity = Math.max(1, Math.floor((presentation.width - 12) / 8));
    return String(cell)
      .split(/\r\n|\r|\n/)
      .reduce(
        (count, line) =>
          count + Math.max(1, Math.ceil(Array.from(line).length / capacity)),
        0,
      );
  });
  return Math.min(409, Math.max(18, Math.max(...lines, 1) * 15 + 3));
}

// SpreadsheetML allows one hyperlink per cell. Expand the materials column in
// XLSX only, so each ingredient has its own real link without dropping text or
// changing the compact, multi-link Google Sheets layout.
function xlsxItemColumns(table: Table): Table {
  const links = validatedLinks(table.rows, table.links);
  const lists = validatedItemLists(table.rows, table.itemLists, links);
  if (!lists.length) return table;
  const widths = new Map<number, number>();
  const cells = new Map(
    lists.map((list) => [`${list.row}:${list.column}`, list]),
  );
  for (const list of lists)
    widths.set(
      list.column,
      Math.max(widths.get(list.column) ?? 1, list.items.length),
    );
  const columns = (table.rows[0] ?? []).map(
    (_, c) =>
      c +
      [...widths].reduce(
        (extra, [column, width]) => extra + (column < c ? width - 1 : 0),
        0,
      ),
  );
  const rows = table.rows.map((row, r) =>
    row.flatMap((cell, c) => {
      const width = widths.get(c) ?? 1;
      const list = cells.get(`${r}:${c}`);
      return Array.from({ length: width }, (_, i) =>
        r === 0
          ? width === 1
            ? cell
            : cell === "Materials per Craft"
              ? `Material ${i + 1}`
              : `${cell} ${i + 1}`
          : list
            ? (list.items[i]?.text ?? "")
            : i === 0
              ? cell
              : "",
      );
    }),
  );
  return {
    ...table,
    rows,
    itemLists: [],
    links: [
      ...links.map((link) => ({
        ...link,
        column: columns[link.column] ?? link.column,
      })),
      ...lists.flatMap((list) =>
        list.items.map((item, i) => ({
          row: list.row,
          column: (columns[list.column] ?? list.column) + i,
          url: item.url,
        })),
      ),
    ],
    ...(table.relativeDates
      ? {
          relativeDates: table.relativeDates.map((date) => ({
            ...date,
            column: columns[date.column] ?? date.column,
          })),
        }
      : {}),
  };
}

// XLSX and CSV are snapshots at Generated At. Excel has no portable viewer-UTC
// clock, so only Sheets uses the live-relative formula. XLSX text stays literal.
export function toXlsx(tables: Table[]): Uint8Array {
  const classNames = [
    ...new Set(
      tables.flatMap((table) => {
        const index = table.rows[0]?.indexOf("Class") ?? -1;
        return index < 0
          ? []
          : table.rows
              .slice(1)
              .map((row) =>
                String(row[index] ?? "")
                  .trim()
                  .toLowerCase(),
              )
              .filter(Boolean);
      }),
    ),
  ];
  const classStyles = classNames.map(classStyle);
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
    `<styleSheet xmlns="${ns}"><fonts count="${3 + classStyles.length}"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font>${classStyles.map((style) => `<font><b/><color rgb="FF${style.foreground}"/><sz val="11"/><name val="Calibri"/></font>`).join("")}<font><u/><color rgb="FF0563C1"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="${4 + classStyles.length}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF173B53"/></patternFill></fill>${classStyles.map((style) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${style.background}"/></patternFill></fill>`).join("")}<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${5 + classStyles.length}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment wrapText="1"/></xf>${classStyles.map((_, i) => `<xf numFmtId="0" fontId="${i + 2}" fillId="${i + 3}" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="top" wrapText="1"/></xf>`).join("")}<xf numFmtId="0" fontId="0" fillId="${3 + classStyles.length}" borderId="0" xfId="0" applyFill="1"><alignment vertical="top" wrapText="1"/></xf>${[0, 3 + classStyles.length].map((fill) => `<xf numFmtId="0" fontId="${2 + classStyles.length}" fillId="${fill}" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="top" wrapText="1"/></xf>`).join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  );
  tables.forEach((inputTable, i) => {
    const table = xlsxItemColumns(inputTable);
    validatedRelativeDates(table);
    const links = validatedLinks(table.rows, table.links);
    const linkCells = new Set(
      links.map((link) => `${link.row}:${link.column}`),
    );
    if (links.length)
      add(
        `xl/worksheets/_rels/sheet${i + 1}.xml.rels`,
        `<Relationships xmlns="${relns}">${links.map((link, j) => `<Relationship Id="link${j + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(link.url)}" TargetMode="External"/>`).join("")}</Relationships>`,
      );
    const width = table.rows[0]?.length ?? 1;
    const last = `${column(width - 1)}${Math.max(1, table.rows.length)}`;
    const classColumn = table.rows[0]?.indexOf("Class") ?? -1;
    const frozen = ["Characters", "Professions"].includes(table.name);
    const shadedRows = new Set<number>();
    if (table.name === "Professions")
      for (const group of playerGroups(table.rows)) {
        if (group.shaded)
          for (let r = group.start; r < group.end; r++) shadedRows.add(r);
      }
    const rows = table.rows
      .map(
        (row, r) =>
          `<row r="${r + 1}"${r === 0 ? ' ht="32" customHeight="1"' : ["Characters", "Professions", "Recipes"].includes(table.name) ? ` ht="${professionRowHeight(table, row)}" customHeight="1"` : ""}>${row
            .map((cell, c) => {
              const output = r === 0 ? exportHeader(table.name, cell) : cell;
              const colorIndex =
                c === classColumn
                  ? classNames.indexOf(String(cell).trim().toLowerCase())
                  : -1;
              const style =
                r === 0
                  ? 1
                  : linkCells.has(`${r}:${c}`)
                    ? (c < 2 && shadedRows.has(r) ? 4 : 3) + classStyles.length
                    : c < 2 && shadedRows.has(r)
                      ? 2 + classStyles.length
                      : colorIndex < 0
                        ? 0
                        : colorIndex + 2;
              return `<c r="${column(c)}${r + 1}" s="${style}" t="${typeof output === "number" ? "n" : "inlineStr"}">${typeof output === "number" ? `<v>${output}</v>` : `<is><t xml:space="preserve">${xml(output)}</t></is>`}</c>`;
            })
            .join("")}</row>`,
      )
      .join("");
    add(
      `xl/worksheets/sheet${i + 1}.xml`,
      `<worksheet xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ${frozen ? 'xSplit="2" ' : ""}ySplit="1" topLeftCell="${frozen ? "C2" : "A2"}" activePane="${frozen ? "bottomRight" : "bottomLeft"}" state="frozen"/></sheetView></sheetViews><cols>${(
        table.rows[0] ?? [""]
      )
        .map((header, c) => {
          const presentation = columnPresentation(
            table.name,
            String(exportHeader(table.name, header)),
          );
          return `<col min="${c + 1}" max="${c + 1}" width="${(presentation.width / 7).toFixed(2)}" customWidth="1"${presentation.hidden ? ' hidden="1"' : ""}/>`;
        })
        .join(
          "",
        )}</cols><sheetData>${rows}</sheetData><autoFilter ref="A1:${last}"/>${links.length ? `<hyperlinks>${links.map((link, j) => `<hyperlink ref="${column(link.column)}${link.row + 1}" r:id="link${j + 1}"/>`).join("")}</hyperlinks>` : ""}</worksheet>`,
    );
  });
  return zipSync(files, { level: 6 });
}
