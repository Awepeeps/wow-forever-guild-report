# WoW Forever Guild Report

Build a guild roster workbook from Blizzard's API. Discover every guild member, map characters to Discord names in private JSON, and refresh character levels, guild ranks, talent-tree point spend, primary profession levels, and secondary professions.

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

| Tab          | Contents                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------- |
| Characters   | Compact roster: Discord, name, class, level, guild rank, talent points, human Notes and API status  |
| Professions  | One row per character/profession/tier, including all secondaries and skill/max                      |
| Guild Info   | Guild, region, generation timestamp, counts by class/faction/ruleset, mapping and API availability  |
| Export Notes | How to read the export: layout, class colors, identity, freshness, source links and API limitations |

Characters and Professions sit side by side, with Discord/name columns frozen. Class cells use recognizable WoW colors with contrasting text; Priest uses light gray. Guild Info shows the export timestamp. Race, faction, ruleset, identity, repeated generation times and per-component diagnostics remain in hidden columns that can be unhidden. CSV files include every column. Professions labels retained data explicitly and keeps characters with unavailable data as placeholder rows rather than silently omitting them.

Each export also includes four CSV files and `snapshot.json`. Offline `just export` defaults to `output/export/`; API `just refresh` defaults to `output/roster/`. Offline export refuses to replace a snapshot containing API statuses, even with an explicit output path. Characters sort by **Discord name, then character name, with unmapped characters last**; ties use the API slug. Names compare in English with case-insensitive grouping and deterministic case ties. API return order does not affect the workbook.

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

Guild Rank is the **numeric API rank**, with 0 for guild master; custom rank titles are not guessed. Profession tiers are retained individually. Skill `0` is distinct from unknown (blank/`unknown`). All returned secondary professions are included, such as Cooking, Fishing, and First Aid where supported.

Guild Info shows **Generated At** in UTC; repeated generation times on Characters and Professions are hidden by default. **Fetched At** is the refresh attempt time; per-component **Last Success** columns indicate when retained data was last retrieved successfully. These timestamps describe this tool's fetches, not Blizzard's underlying update time. Blizzard profiles can lag until logout. Failed requests retain prior values, with failure status and the prior last-success timestamp.

## Publish to Google Sheets

Excel/CSV import works without Google credentials. For repeatable direct updates, create a **new empty spreadsheet**, enable the Google Sheets API in your Google Cloud project, and either:

1. Create a service account, save its JSON key under `.local/`, and share the spreadsheet with its email as **Editor**. Set `GOOGLE_SERVICE_ACCOUNT_FILE=.local/google-service-account.json`, or provide the key as one-line JSON in `GOOGLE_SERVICE_ACCOUNT_JSON` (for example from Infisical), which takes precedence.
2. Inject a short-lived OAuth token with the `https://www.googleapis.com/auth/spreadsheets` scope as `GOOGLE_ACCESS_TOKEN`. This takes precedence over the service account file.

Set `GOOGLE_SPREADSHEET_ID` to the ID in the sheet URL, then run:

```sh
just sheets     # publish output/roster/snapshot.json
```

The tool creates Characters, Professions, Guild Info, and Export Notes with ownership metadata and places them first in that order. A managed Data Notes tab is renamed to Export Notes in the same atomic batch, preserving its sheet ID; a collision stops the update. Unmanaged tabs are never renamed. Later updates replace only the owned tabs. An existing target tab with no ownership marker is refused before any write: **human tabs are never taken over**. To add generated tabs to an existing hand-maintained spreadsheet, first rename its clashing tabs (for example `Characters (old)`). Other tabs keep their contents. Don't remove the ownership metadata or change the generated identity/header columns.

**Notes belongs to humans.** CSV/API imports never read Notes, and local exports leave that column blank. In managed Google Sheets, existing Notes cell values are carried by region + character identity when rows reorder. If a departing/unidentified character has Notes, publishing stops before changing the sheet; archive the note elsewhere and clear the old cell before retrying. Avoid editing Notes during publishing: the Sheets API has no compare-and-swap for concurrent cell edits. Keep long-term freeform notes in a separate human-owned tab if you need independent editing.

Notes cell values and cell formatting are preserved by identity, including when the column moves. Duplicate identities with Notes content or formatting stop publication until the duplicate rows are resolved. Other generated formatting, dimensions, filters, and cells are tool-owned. Service account tokens are minted in memory; private keys and access tokens are never placed in workbook output. A failed write is not retried automatically because the outcome may be ambiguous.

The Export Notes rename also changes the generated CSV filename from `data-notes.csv` to `export-notes.csv`; update scripts using the old name. Sheets requests exceeding 8 MB stop before writing; very large rosters or extensive Notes formatting may require using the XLSX export instead.

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

Forever is an official Blizzard product. As checked **2026-11-07**, its launch-week API routes are still undocumented in the developer portal. This adapter uses the realmless routes reported in the [Blizzard forum research](https://us.forums.blizzard.com/en/blizzard/t/wow-forever-api-what-works-so-far-plus-a-ts-client/60334) and the corresponding [client author's types](https://github.com/Pinta365/blizzard_api/tree/main/src/wow_forever), with runtime validation and mocked contract tests. An authenticated **US live check on 2026-11-07** verified guild discovery, ranks, profiles, profession levels/secondaries, talent-tree point spend and expected per-character 404 handling. Real responses and credentials remain private; automated tests use synthetic fixtures. Other regions have not been live-verified by this project. Low-level/unpublished characters may return 404. Unexpected response shapes are flagged; no HTML scraping or Retail fallback is used.
