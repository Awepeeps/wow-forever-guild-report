# Working on WoW Forever Guild Report

Use Bun 1.4.3 and `just` recipes. This is a CLI, not a hosted website. The public repository contains synthetic fixtures only; real guild rosters, Discord maps, credentials and exports live in ignored `.local/`, `.env.local`, and `output/`.

## Code ownership and architecture

The lead agent writes implementation code. Delegate research, analysis, and independent reviews when requested; do not let review agents edit the shared checkout. Honor the user's requested model/provider choices and report unavailable models.

- `src/model.ts`: runtime input/output schemas and shared domain types.
- `src/blizzard.ts`: the isolated Forever API adapter. No Retail paths or Armory HTML fallback.
- `src/http.ts`: bounded retries/timeouts and safe errors. API response bodies, URLs with tokens, and credential values must not enter errors/logs.
- `src/roster.ts`: guild discovery, independent enrichment, retained data, status, and sorting.
- `src/workbook.ts`: pure table/CSV/OOXML renderers. Keep formulas out of XLSX/CSV. The user-requested view-relative Last Login in Google Sheets is the only generated-formula exception: a fixed DATE/TODAY template built from validated numeric date parts, never raw data or arbitrary expressions. Only deterministic HTTPS Armory/Wowhead public links and the exact upstream source repository/issues links requested by the user may be emitted; never accept arbitrary link targets from API/config data.
- `src/crafting.ts`: recipe-detail enrichment and private caching, separate from per-character knowledge. Original recipe IDs address Blizzard's static Forever recipe endpoint. Preserve all reagents/output quantities; missing is unknown. Failures retain values with visible labels and original last-success timestamps. Auction estimates stay disabled until the guild's exact market is verified.
- `src/presentation.ts`: shared column widths/visibility and readable class colors for XLSX and Google Sheets.
- `src/sheets.ts`: explicit Google writes, ownership checks, preservation of human Notes.
- `src/files.ts`, `src/import.ts`, `src/cli.ts`: private I/O, migration, command orchestration.

Keep validation at trust boundaries, pure transforms easy to test, and external services injectable. Never use `any` to bypass unknown JSON. Prefer minimal dependencies over a large client SDK when only a few endpoints are needed.

## Domain invariants

Forever identities are region + character ID where available, otherwise region + API slug. Names include a surname; rulesets replace realms. Prefer API slugs over reconstruction. Discord names/IDs stay strings. Guild rank stays the numeric API value; display names come only from the private guildRankNames mapping, never inference.

Characters and Professions sort by numeric guild rank, Discord, then character name, with unknown ranks last and unmapped Discord entries last within rank; ties are deterministic. Talent points come from `spent_points` for active groups; never guess a spec or sum different groups. Preserve every returned profession tier and secondary profession. Unknown is not zero.

Tab order is Characters, Professions, Recipes, Guild Info, Automated Export Info. Professions has one row per character with primary and secondary summaries preserving all tiers. Recipes aggregates known recipe IDs by profession, deduplicates characters across tiers and labels retained/manual knowledge. Exact Wowhead crafting links use a separately imported, build-pinned SkillLineAbility.ID → Spell table persisted with provenance in the private snapshot; never hardcode per-recipe mappings or guess from names. Unmapped recipes remain unlinked and visibly marked until the map is updated. Missing recipe arrays mean unknown coverage, not zero recipes. Retain prior recipes for a matching profession/tier when a successful response omits its list, with a per-tier success timestamp and visible retained/incomplete status. An explicit empty list clears that knowledge; different professions/tiers never inherit it. Use the same Complete/Unavailable/Incomplete/Manual display enum on both roster tabs, with retained data marked Incomplete; Character status covers profile/talents and Profession status covers skills/recipes. Live-relative Last Login requires the validated en_US Sheets locale, uses the target timezone and hourly-or-faster recalculation; other locales stop before writing until their formula grammar is validated. XLSX/CSV are labelled static at-export snapshots in UTC. Keep technical diagnostics hidden and Player Notes (Editable) visible and independently human-owned on both roster tabs. Only owned legacy Data Notes/Export Notes tabs may migrate to Automated Export Info; never rename an unmanaged tab or overwrite a collision. Legacy Characters Notes migrates by header name and identity.

A guild lookup/auth failure must not publish an empty successful roster. Individual endpoint failures keep prior/supplied data and mark it incomplete. Keep last-success timestamps when values are retained. `Generated At`/fetch times must not be represented as Blizzard update times.

Notes is human-owned: never import it from CSV/API/config. Google updates require app ownership metadata and preserve Notes by identity. Stop before deleting notes for a departed/unidentified character. Unrelated tabs are outside the write scope. Google writes use a single atomic batch and are not retried after ambiguous failure. External publication must be requested; a code/PR task does not authorize publishing real guild data.

## Checks and evidence

Run `just install`, `just tools`, then `just check`; use `just demo` and `just env-check` for entrypoint/schema validation. Test behavior that can lose/corrupt data or leak credentials: endpoint paths, schemas, failed calls, notes movement, formula injection, credential requirements, and private file boundaries. Avoid tests that only match implementation wording. Validate XLSX changes with an independent reader when available.

Gitleaks scans history/working files; `scripts/check-publication.ts` rejects forcibly tracked private paths even where the local scanner ignores them. Never weaken either check merely to get green. Do not attach real API fixtures or generated guild artifacts to CI, issues, PRs, or chat. CI never requires live credentials. Use exact dependency versions, the Bun lockfile, and commit-pinned Actions.

Use the repo skill [refresh-roster](.agents/skills/refresh-roster/SKILL.md) for operating/importing a roster and [verify-forever-api](.agents/skills/verify-forever-api/SKILL.md) when endpoint/schema assumptions change. Read [docs/infisical.md](docs/infisical.md) before changing secret resolution; homelab provisioning belongs to its owning project.
