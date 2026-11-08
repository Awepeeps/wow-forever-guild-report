# WoW Forever Guild Report

Build a guild roster workbook from Blizzard's API. Discover every guild member, map characters to Discord names in private JSON, and refresh character levels, guild ranks, talent-tree point spend, item levels, last login, achievement points, primary/secondary profession levels and known recipes.

TypeScript on Bun, with `just` as the command interface and Varlock for configuration. No Armory scraping, Discord bot, account password, or web server.

Canonical repository: [Awepeeps/wow-forever-guild-report](https://github.com/Awepeeps/wow-forever-guild-report).

## Quick start

Install Bun **1.4.3** and just **1.45.0**. Linux/macOS are supported; Windows users can use WSL.

```sh
just install
just tools       # checksum-pinned Gitleaks 8.30.1 into .local/bin
just check
just demo        # synthetic data, no credentials/network API access
```

Open `output/demo/roster.xlsx` in Excel, LibreOffice, or Google Sheets. It has frozen headers and filters:

| Tab                   | Contents                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Characters            | Discord, character, rank, class, level, talents, achievements, iLvl, Last Login, Character API Status, Player Notes (Editable) |
| Professions           | One row per character: primary professions, secondary professions, status, Player Notes (Editable)                             |
| Recipes               | Profession, recipe, crafting output, materials per craft, known characters/Discord and detail/knowledge status                 |
| Guild Info            | Guild, region, generation timestamp, class/faction/ruleset counts and API availability                                         |
| Automated Export Info | Layout, class colors, identity, freshness, source links and API limitations                                                    |

Characters and Professions sit side by side, with Discord/name columns frozen. Both sort by **numeric guild rank, then Discord name, then character name**. Unknown ranks come last; within each rank, unmapped Discord entries come last. Names compare in English with case-insensitive grouping and deterministic case ties; the API slug breaks remaining ties. API return order does not affect the workbook, including when rendering an older snapshot.

Professions shades contiguous runs of the same Discord player on the name columns. Rank-first sorting can split one player’s characters across ranks; shading does not imply a global player group. Each category cell lists every profession/tier on its own line as `Alchemy (Classic) — 50/75`; `?` means unknown and `0` remains zero. Characters without available professions stay visible with an explicit status. Both tabs have independent **Player Notes (Editable)** columns; local exports leave them blank. XLSX profession rows have explicit heights for multiline/wrapped summaries, capped at Excel’s row-height limit; unusually large categories may need inspecting the full cell text.

Class cells use recognizable WoW colors with contrasting text; Priest uses light gray. Guild Info shows the export timestamp. Race, faction, ruleset, numeric rank, identity, repeated generation times and component diagnostics remain in hidden columns that can be unhidden. CSV files include every column.

Each export includes five CSV files and `snapshot.json`. Offline `just export` defaults to `output/export/`; API `just refresh` defaults to `output/roster/`. Offline export refuses to replace a snapshot containing API statuses, even with an explicit output path.

## Configure your guild

```sh
mkdir -p .local
chmod 700 .local
cp examples/guild.json .local/roster.json
cp examples/discord-map.json .local/discord-map.json
cp .env.example .env.local
chmod 600 .env.local .local/*.json
```

Set your actual guild slug/region in `.local/roster.json`:

```json
{
  "version": 1,
  "region": "us",
  "locale": "en_US",
  "guild": "your-guild-slug",
  "guildRankNames": { "0": "Guild Master", "1": "Officer", "2": "Veteran" },
  "characters": []
}
```

The slug is the last path segment in `.../forever/us/armory/guild/your-guild-slug`. Forever is realmless: use **no realm segment**. `characters` is optional; use explicit entries only for extra characters or offline migration. Regions: `us`, `eu`, `kr`, `tw`; CN is not supported. Locale defaults to `en_US`; choose an appropriate Blizzard locale for other regions.

Create a developer application at [Blizzard API Access](https://develop.battle.net/access/clients). Put its values in `.env.local`:

```dotenv
BLIZZARD_CLIENT_ID=your-client-id
BLIZZARD_CLIENT_SECRET=your-client-secret
DISCORD_MAP_FILE=.local/discord-map.json
```

Public guild/character endpoints use **client credentials OAuth**. User OAuth scopes, redirect callbacks, and a Battle.net user password are not used. Never paste credentials into commits, chat, shell command arguments, or JSON roster files.

Private Discord mapping format:

```json
{
  "us:example-priest": "discord_username",
  "us:id:1234567": "same_person_for_an_alt"
}
```

Keys are region plus the lowercase API-provided character slug; an optional `region:id:characterID` mapping takes precedence and survives character renames. Values are strings (Discord handles, display names, or snowflake IDs). Multiple characters can map to one Discord name. Unmapped members remain in the roster with an empty Discord cell. An unset `DISCORD_MAP_FILE` permits an unmapped roster; a configured missing or invalid file stops the command before writing. No automatic Discord identity matching is attempted.

```sh
just env-check   # Varlock validates the configuration; secret values are redacted
just refresh     # .local/roster.json -> output/roster/
```

Each refresh discovers the guild anew and fetches profile, professions, and specializations for every member, with four workers and bounded retries/timeouts. It reuses the previous output snapshot to retain known values when an individual endpoint fails, including a character-specific 403. Omitted fields in explicit character overrides retain prior values; an explicit empty array intentionally clears that supplied baseline. A failed guild lookup, OAuth error, or API 401 stops before writing exports. Departed members disappear from the new roster; explicit `characters` remain included. Do not run two refreshes into the same output directory concurrently.

Exit codes: **0** complete, **2** partial API data exported, **1** failed (no new snapshot). Review the per-component status and Sync Notes before publishing partial results. A shell chain with `&&` intentionally does not auto-publish an exit-2 refresh.

Retention matches stable character IDs across renames. Slug fallback is used only when at least one side lacks an ID; conflicting IDs never share history or last-success timestamps. Guild discovery supplies the current ID and slug. Duplicate IDs/slugs or an ID conflict during enrichment stop the refresh before writing, so a reused name cannot inherit another character's data. Prefer ID-based Discord mappings when available.

## Talents, ranks, and freshness

Talents display actual points such as `Shadow Magic 5, Discipline 2`. They come from `spent_points` in active specialization groups, never from a guessed role, talent count, or summed talent ranks. Multiple active groups are labelled separately and never summed together. A known empty group means no allocated points; an unsupported response is flagged rather than treated as zero. Inactive builds are not shown.

The live US guild/profile and roster APIs were checked on 2026-11-07: ranks are numeric and no rank-title field was returned. Put your guild’s confirmed titles in the optional `guildRankNames` object in the ignored roster config; keys must be integer strings `0`–`999` and values nonempty labels. Guild Rank displays that label or `Rank N (unmapped)`. The numeric API value remains canonical, controls sorting, and is retained in the hidden Guild Rank Number column. The mapping is saved in each snapshot for reproducible offline exports; old snapshots default to an empty map. Removing the current config mapping deliberately removes its labels on the next refresh; it does not retain old titles. Older CLI versions cannot read new snapshots containing this field, so keep a private backup before downgrading. Custom titles are never guessed. All profession tiers and returned secondaries are retained; `?` denotes unknown skill/maximum, distinct from `0`.

Guild Info shows **Generated At** in UTC; repeated generation times on Characters and Professions are hidden by default. **Fetched At** is the refresh attempt time; per-component **Last Success** columns indicate when retained data was last retrieved successfully. These timestamps describe this tool's fetches, not Blizzard's underlying update time. Blizzard profiles can lag until logout. Failed requests retain prior values, with failure status and the prior last-success timestamp.

Guild Info groups character/profession/recipe coverage beside the last refresh. Optional `reportTimeZone` in the private config selects the local refresh label (for example `America/New_York`); it defaults to UTC and is saved in the snapshot. This changes only the refresh label: Sheets Last Login continues to use the spreadsheet's own timezone, and XLSX/CSV last-login ages remain UTC snapshots.

## Exact recipe links

Import a mapping for an explicit Forever client build, then attach it during refresh:

```sh
just recipe-map 1.60.1.70862 .local/recipe-map-1.60.1.70862.json
just refresh .local/roster.json output/roster .local/recipe-map-1.60.1.70862.json
```

This separate setup command downloads the `SkillLineAbility` CSV from a fixed wago.tools URL, validates its ID/Spell columns, rejects duplicates and oversized responses, and writes a private mapping without overwriting an existing file. It imports all nonzero mappings, so newly learned recipes resolve on subsequent refreshes too. No recipe names or individual IDs are hardcoded. The full mapping, build, source SHA-256 and fetch timestamp travel in the ignored snapshot; subsequent refreshes keep that mapping unless a new `recipe_map` argument is supplied. Rendering XLSX/CSV or publishing a saved snapshot is deterministic and requires no Wowhead or wago.tools requests.

On a client update, import the new build into a new file and pass it to refresh. An unknown recipe stays unmapped until the table is updated; it is never linked to an unrelated entity. Guild Info reports mapping provenance and exact-link coverage; the hidden Wowhead Spell ID and original Recipe ID columns permit cross-checking. Old snapshots without a mapping still render with unlinked, explicitly unmapped recipes.

The table mirror is unofficial and not a Blizzard API contract. The bridge was cross-checked against Wowhead's Forever tooltip resolver and client data; Wowhead spell and crafted-item IDs are separate. No third-party data tables or real recipes are committed to this repository. Source: [wago.tools SkillLineAbility](https://wago.tools/db2/SkillLineAbility), [Wowhead tooltips ID guidance](https://www.wowhead.com/tooltips).

## Character metrics and recipe lookup

Characters shows Discord, Character Name, Guild Rank, Class, Level, Talent Points, Achievement Points, iLvl (equipped item level), Last Login, Character API Status and Player Notes (Editable), in that order, followed by API Details. Both roster tabs show a short API Details explanation for unavailable/failed components or retained recipe lists. XP is not exported. Average item level and the exact Last Login (UTC) timestamp remain hidden. Blank means unknown; zero remains zero. A failed profile retains prior metrics with the old Profile Last Success; a successful profile that omits a metric clears it to unknown.

Google Sheets Last Login uses a fixed generated `TODAY()` / numeric `DATE()` formula to show **Today**, **1 day ago**, or **N days ago** using the spreadsheet's calendar timezone. Dates ahead of the viewing day say Future date. The publisher sets an ON_CHANGE calculation setting to HOUR so labels continue ageing while open; existing MINUTE/HOUR settings are preserved. Google must return the timezone and an `en_US` spreadsheet locale before any write. Other formula locales (including `de_DE` and `fr_FR`, which use different separators) fail closed until their formula grammar is validated; the publisher never changes the spreadsheet locale. This recalculates age from the stored login; it does not refresh Blizzard data. XLSX/CSV are static snapshots, labelled **Last Login (at export)** using UTC dates as of Generated At. Excel does not expose a portable UTC clock, so downloaded files do not mix a UTC event date with the viewer's local `TODAY()`.

Both API-status columns share **Complete / Unavailable / Incomplete / Manual**. Character API Status covers profile and talent requests; Profession API Status covers profession data, including retained recipe knowledge. Complete means its components succeeded. Unavailable means all relevant endpoints returned 404 and there is no retained detail to show. Incomplete covers mixed/failed requests or retained data. Manual means supplied data without API refresh. API Details explains failures visibly; last-success timestamps remain in hidden diagnostics.

Recipes sits immediately after Professions. It lists profession, recipe and known characters with their Discord names, sorted by profession then recipe name and ID. Knowers use the roster's rank/Discord/name order. Recipe IDs distinguish equal names; a character knowing the same recipe in several tiers appears once. Large knower lists continue on the next row to stay within Excel's cell limit. This sheet is generated, with no editable notes column.

**Makes** and **Materials per Craft** use authenticated `GET /data/wow/recipe/{recipeId}?namespace=static-forever-{region}` responses, not Wowhead scraping or name matching. Successful US probes on 2026-11-08 returned `crafted_item`, `crafted_quantity.value`, and `reagents[].reagent/quantity`; the adapter also validates the documented minimum/maximum quantity shape with synthetic fixtures. All returned materials/quantities are kept. Missing fields remain unknown; an explicit empty reagent list is displayed as None reported. Output IDs and numeric yield bounds remain in hidden columns and CSV/snapshot data. Metadata fetching is separate from character knowledge, so a recipe-detail failure does not change a character's profession status.

Refresh fetches each distinct recipe ID at most once, with four workers and a 24-hour private cache in `snapshot.json`. Changing the pinned mapping build bypasses the cache. Failed detail requests retain old values and their original success timestamp, visibly marked **Retained — refresh failed**; new unavailable details stay unknown. Successful responses replace prior metadata, including fields now omitted. Recipe Details and hidden last-success/last-attempt columns distinguish these cases. Authentication/401 failures abort before exports; other detail failures produce an exit-2 partial export. Offline exports and publishing a saved snapshot do not fetch recipe metadata.

**Auction price estimates remain disabled.** Live US Forever auction endpoints respond, but their index lists multiple identically named houses without a verified Roleplay versus Roleplay-PvP assignment. The ruleset route parameter does not establish a house's market. Guild Info and Automated Export Info disclose this; no other market's prices, assumed vendor costs, zero-cost unknown materials, or estimated profits are substituted. Price integration requires verifying the guild's exact market first.

Failed profession calls retain recipe knowledge with a per-character last-success label. A successful response that omits a recipe list retains prior knowledge only for the same profession and tier, labelled as retained with its original recipe-specific last-success time. Skill levels can still update; Profession API Status says Incomplete and refresh exits 2. Explicit empty recipe lists clear prior knowledge. Unlearned professions or different tiers never inherit it. Manual knowledge is labelled separately. Missing `known_recipes` arrays mean **unknown coverage**, whereas empty arrays mean no recipes returned for that tier. Guild Info reports current full-coverage characters versus the roster total; Professions has a hidden Recipe Coverage column for Current/Partial/Unknown/Retained/Manual. Knower Data describes the listed knowers only; Current reports does not imply complete guild coverage. A successful response with no professions counts as current empty knowledge. XLSX row heights are capped, so inspect full cell text for unusually long knower lists. The lookup contains only known recipes returned by the API, not a complete recipe catalogue, so absence never proves nobody in the guild knows a recipe. Old snapshots still render, with unknown recipe coverage until refreshed.

Character names on both roster tabs link to the main Forever Armory page for talent drill-down. Recipe names link to **exact Wowhead Forever crafting spell pages**, using the client table bridge `SkillLineAbility.ID → Spell`. The API recipe ID is never used as a spell ID, and names are never used to guess a match. The spell page shows crafting ingredients and results. Recipes missing from the pinned table are labelled **Unmapped — update recipe map** and have no link; no name search is substituted. The Armory route and recipe-ID bridge were verified from public sources on 2026-11-07 (US/EU); other supported regions have not been verified. Hidden Armory URL / Recipe URL columns keep targets in CSV. XLSX uses real hyperlink relationships and Sheets uses text-format links, without hyperlink formulas. Only the fixed view-relative Last Login template can emit a generated formula in Sheets; all data strings remain literal. Automated Export Info includes a clickable Source code (upstream) link to https://github.com/Awepeeps/wow-forever-guild-report in Sheets and XLSX; CSV retains the URL. Automated Export Info also links to the exact upstream issues page for reporting problems. Only the approved HTTPS Armory/Wowhead routes and those exact source repository/issues links are accepted.

## Publish to Google Sheets

Excel/CSV import works without Google credentials. For repeatable direct updates, create a **new empty spreadsheet**, enable the Google Sheets API in your Google Cloud project, and either:

1. Create a service account, save its JSON key under `.local/`, and share the spreadsheet with its email as **Editor**. Set `GOOGLE_SERVICE_ACCOUNT_FILE=.local/google-service-account.json`, or provide the key as one-line JSON in `GOOGLE_SERVICE_ACCOUNT_JSON` (for example from Infisical), which takes precedence.
2. Inject a short-lived OAuth token with the `https://www.googleapis.com/auth/spreadsheets` scope as `GOOGLE_ACCESS_TOKEN`. This takes precedence over the service account file.

Set `GOOGLE_SPREADSHEET_ID` to the ID in the sheet URL, then run:

```sh
just sheets     # publish output/roster/snapshot.json
```

The tool creates Characters, Professions, Recipes, Guild Info, and Automated Export Info with ownership metadata and places them first in that order. An owned Data Notes or Export Notes tab is renamed to Automated Export Info in the same atomic batch, preserving its sheet ID; multiple owned legacy tabs or a target-name collision stop the update. Unmanaged tabs are never renamed. Later updates replace only the owned tabs. An existing target tab with no ownership marker is refused before any write: **human tabs are never taken over**. To add generated tabs to an existing hand-maintained spreadsheet, first rename its clashing tabs (for example `Characters (old)`). Other tabs, including manual guide lists and one-time guide suggestions, keep their contents and are never maintained by the exporter. Don't remove the ownership metadata or change the generated identity/header columns.

**Player Notes (Editable) belongs to humans.** CSV/API/config never supply notes, and local exports leave those columns blank. In managed Google Sheets, Characters and Professions preserve their own notes by region + character identity when rows reorder. The old Characters Notes header migrates automatically; the legacy multi-row Professions layout gains a new, empty notes column. Notes are never copied between the two tabs. ID-based notes never attach to a conflicting ID; a legacy slug-only note may upgrade to the current ID at that slug because no prior ID exists to distinguish a rename/upgrade from name reuse. Prefer stable-ID snapshots and avoid editing hidden identity cells. Missing or ambiguous editable headers stop publication instead of discarding notes. If a departing/unidentified character has Notes, publishing stops before changing the sheet; archive the note elsewhere and clear the old cell before retrying. Avoid editing Notes during publishing: the Sheets API has no compare-and-swap for concurrent cell edits. Keep long-term freeform notes in a separate human-owned tab if you need independent editing.

Notes cell values and cell formatting are preserved by identity, including when the column moves. Duplicate identities with Notes content or formatting stop publication until the duplicate rows are resolved. Other generated formatting, dimensions, filters, and cells are tool-owned. Service account tokens are minted in memory; private keys and access tokens are never placed in workbook output. A failed write is not retried automatically because the outcome may be ambiguous.

The information-tab rename changes the generated CSV filename from `data-notes.csv` / `export-notes.csv` to `automated-export-info.csv`; update scripts using either old name. Profession CSV rows now contain category summaries rather than one row per skill/tier. Sheets requests exceeding 8 MB stop before writing; very large rosters or extensive Notes formatting may require using the XLSX export instead.

## Import the existing roster

Download the original Characters tab as CSV, save it under `.local/`, and use a fresh destination directory:

```sh
just import-csv .local/original.csv .local/imported/roster.json
```

The importer expects the original 12 headers (Discord through Notes), handles quoted/multiline values and blank rows, and writes a sibling `discord-map.json`. **Notes and Spec 1/Spec 2 are intentionally not imported**. Use the Discord map for guild discovery by setting `DISCORD_MAP_FILE=.local/imported/discord-map.json`; keep the guild config as your refresh input. Explicit imported characters are useful for offline exports:

```sh
just export .local/imported/roster.json output/imported
```

The importer derives candidate slugs from full names; check them against the actual API slugs before relying on them, especially names with punctuation. Existing destination configs/maps are never overwritten by import.

## Configuration and secret management

`.env.schema` is the public contract; `.env.local` holds local values. Bun's automatic dotenv loading is disabled in `bunfig.toml`. Every CLI recipe launches through **`varlock run`**, and the entry point imports `varlock/auto-load` for runtime redaction. The demo explicitly selects the synthetic Discord map. Keep real data in `.local/` and `output/`, both ignored. Private Discord-map and service-account filenames are also ignored and rejected by the publication guard outside the explicit synthetic example allowlist. New files are written with mode 0600 and atomic rename; protect existing parent directories and backups too.

Blizzard and Google secrets are optional in the shared schema so offline exports/checks work without credentials. Commands validate their own required credentials. `just env-check` validates supplied values; it is not a live authentication test. Do not use Varlock reveal/export commands in captured logs.

A machine can load the same values from self-hosted Infisical instead; see [Loading secrets from Infisical](docs/infisical.md). It is opt-in through the private `.env.local`, fails closed and never runs in CI. No infrastructure is provisioned by this project.

## Engineering checks

`just check` runs Biome lint/format checks, strict TypeScript, Bun behavior tests, high-severity dependency auditing, a publication path guard, and Gitleaks against Git history and working files. Run `just hooks` to opt into the repo's secret-checking pre-commit hook (this sets local `core.hooksPath`). CI runs the same recipes plus the offline demo and Varlock validation on PRs and branch pushes; no live secrets or guild exports enter CI or uploaded artifacts. Actions are pinned by commit, dependencies by exact version/lockfile; Dependabot checks updates weekly.

There is no deployment service to run. For automation, schedule `just refresh` locally or on a trusted runner; add `just sheets` only when publishing is desired. Keep secrets on that machine/secret provider and handle exit code 2 explicitly. Do not place private roster artifacts in public CI logs/artifacts.

Architecture and contributor rules are in [AGENTS.md](AGENTS.md); reusable repo skills are under [.agents/skills](.agents/skills).

## API status

Forever is an official Blizzard product. As checked **2026-11-07**, its launch-week API routes are still undocumented in the developer portal. This adapter uses the realmless routes reported in the [Blizzard forum research](https://us.forums.blizzard.com/en/blizzard/t/wow-forever-api-what-works-so-far-plus-a-ts-client/60334) and the corresponding [client author's types](https://github.com/Pinta365/blizzard_api/tree/main/src/wow_forever), with runtime validation and mocked contract tests. An authenticated **US live check on 2026-11-07** verified guild discovery, ranks, profiles, profession levels/secondaries, profile metrics, recipe response fields, talent-tree point spend and expected per-character 404 handling. Real responses and credentials remain private; automated tests use synthetic fixtures. Other regions have not been live-verified by this project. Character APIs can return 404 even while the official Armory displays data; this is not a Discord-mapping failure or proof that a character has no data. Guild roster class IDs are resolved through the Forever static class index, so class and level can still appear while profile/profession/talent calls remain incomplete. No Armory HTML is imported. An optional class-index failure leaves class unknown without invalidating guild discovery. Unexpected response shapes are flagged; no HTML scraping or Retail fallback is used.
