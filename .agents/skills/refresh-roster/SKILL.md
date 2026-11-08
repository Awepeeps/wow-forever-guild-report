---

name: refresh-roster
description: Import a WoW Forever roster CSV, maintain private Discord mappings, refresh a guild workbook, or publish an explicitly requested Google Sheets update in this repository.
---

Use `just` and the schemas in `src/model.ts`; read README for command arguments. Keep local data under `.local/` and output under `output/`. Do not echo config/map contents or raw API responses.

For guild refreshes, take region/guild slug from the supplied Forever guild URL. The guild roster is authoritative; use explicit characters only when requested. Resolve Discord from the ignored JSON map; `region:id:ID` keys take precedence over `region:slug`. Never infer a Discord identity from a similar name.

Use `just import-csv` to migrate the original CSV into a fresh private directory. It omits Notes and planned specs. Point `DISCORD_MAP_FILE` at the imported mapping, then refresh using the guild config. Preserve the original CSV privately if the user needs its notes later.

Use `just refresh`; exit 2 writes partial data with status/last-success timestamps. Explain incomplete components instead of claiming a complete refresh. Auth/guild failures exit 1 and must not lead to publishing an empty roster. `just export` is an offline supplied-data export and does not discover guild members.

Credentials must arrive through the environment/Varlock or the host's secure secret-input facility. Do not request credentials in chat. No live credentials are needed for `just demo` or CI.

Publish via `just sheets` only when the current task requests a Google write. It creates/updates Characters, Professions, Recipes, Guild Info and Automated Export Info, preserving independent Player Notes (Editable) values and formats by identity on both roster tabs. Old Notes headers and owned Data Notes/Export Notes tabs migrate safely. Both roster tabs sort by numeric rank, Discord, then character name; rank labels come from the private guildRankNames config map. Professions uses one row per character with separate primary/secondary summaries. Recipes lists known characters per profession/recipe ID, labels retained knowledge and reports coverage on Guild Info. Check newly introduced Recipes tab ownership before publication too. Character/Profession API Status use the same Complete/Unavailable/Incomplete/Manual labels; retained data is Incomplete. Sheets Last Login uses a trusted DATE/TODAY formula in the target timezone and keeps hourly-or-faster recalculation; missing timezone or a locale other than validated en_US stops publication; never change the target locale to work around it. XLSX/CSV dates are static UTC at-export labels. On ownership or note-preservation errors, keep the existing sheet intact; use a new spreadsheet or let the user archive the affected notes. An ambiguous Google write failure requires inspecting the actual outcome before another write.

Report artifact paths, character counts, generation time, and remaining API limitations. Never publish Discord mappings or full roster exports in a PR.

For exact Wowhead crafting links, use `just recipe-map <Forever-client-build> <new-private-json>` once, then pass that path as the third argument to `just refresh`. Subsequent refreshes retain the full mapping in the snapshot, including recipes learned later. New builds use new files; never overwrite the original pinned map. Unmapped recipes remain unlinked and visibly request a mapping update. Guild Info exposes build/hash/fetch-time and coverage. Class/level can come from guild discovery even while the three character endpoints return 404; do not scrape the Armory to fill the remaining blanks.
