# Working on WoW Forever Guild Report

Use Bun 1.4.3 and `just` recipes. This is a CLI, not a hosted website. The public repository contains synthetic fixtures only; real guild rosters, Discord maps, credentials and exports live in ignored `.local/`, `.env.local`, and `output/`.

## Code ownership and architecture

The lead agent writes implementation code. Delegate research, analysis, and independent reviews when requested; do not let review agents edit the shared checkout. Honor the user's requested model/provider choices and report unavailable models.

- `src/model.ts`: runtime input/output schemas and shared domain types.
- `src/blizzard.ts`: the isolated Forever API adapter. No Retail paths or Armory HTML fallback.
- `src/http.ts`: bounded retries/timeouts and safe errors. API response bodies, URLs with tokens, and credential values must not enter errors/logs.
- `src/roster.ts`: guild discovery, independent enrichment, retained data, status, and sorting.
- `src/workbook.ts`: pure table/CSV/OOXML renderers. Keep formulas and external links out of generated workbooks.
- `src/presentation.ts`: shared column widths/visibility and readable class colors for XLSX and Google Sheets.
- `src/sheets.ts`: explicit Google writes, ownership checks, preservation of human Notes.
- `src/files.ts`, `src/import.ts`, `src/cli.ts`: private I/O, migration, command orchestration.

Keep validation at trust boundaries, pure transforms easy to test, and external services injectable. Never use `any` to bypass unknown JSON. Prefer minimal dependencies over a large client SDK when only a few endpoints are needed.

## Domain invariants

Forever identities are region + character ID where available, otherwise region + API slug. Names include a surname; rulesets replace realms. Prefer API slugs over reconstruction. Discord names/IDs stay strings. Guild rank is the numeric API value, not an inferred title.

Characters sort by Discord, then character name, unmapped last, with deterministic ties. Talent points come from `spent_points` for active groups; never guess a spec or sum different groups. Preserve every returned profession tier and secondary profession. Unknown is not zero.

Tab order is Characters, Professions, Guild Info, Export Notes. Keep skill details in Professions, technical diagnostics in hidden columns, and Notes visible and human-owned. Only an owned legacy Data Notes tab may migrate to Export Notes; never rename an unmanaged tab or overwrite a name collision.

A guild lookup/auth failure must not publish an empty successful roster. Individual endpoint failures keep prior/supplied data and mark it incomplete. Keep last-success timestamps when values are retained. `Generated At`/fetch times must not be represented as Blizzard update times.

Notes is human-owned: never import it from CSV/API/config. Google updates require app ownership metadata and preserve Notes by identity. Stop before deleting notes for a departed/unidentified character. Unrelated tabs are outside the write scope. Google writes use a single atomic batch and are not retried after ambiguous failure. External publication must be requested; a code/PR task does not authorize publishing real guild data.

## Checks and evidence

Run `just install`, `just tools`, then `just check`; use `just demo` and `just env-check` for entrypoint/schema validation. Test behavior that can lose/corrupt data or leak credentials: endpoint paths, schemas, failed calls, notes movement, formula injection, credential requirements, and private file boundaries. Avoid tests that only match implementation wording. Validate XLSX changes with an independent reader when available.

Gitleaks scans history/working files; `scripts/check-publication.ts` rejects forcibly tracked private paths even where the local scanner ignores them. Never weaken either check merely to get green. Do not attach real API fixtures or generated guild artifacts to CI, issues, PRs, or chat. CI never requires live credentials. Use exact dependency versions, the Bun lockfile, and commit-pinned Actions.

Use the repo skill [refresh-roster](.agents/skills/refresh-roster/SKILL.md) for operating/importing a roster and [verify-forever-api](.agents/skills/verify-forever-api/SKILL.md) when endpoint/schema assumptions change. Read [docs/infisical.md](docs/infisical.md) before changing secret resolution; homelab provisioning belongs to its owning project.
