---

name: post-merge-refresh
description: After a PR lands on this WoW Forever Guild Report repository's main branch, refresh the private roster, regenerate exports, publish the configured Google spreadsheet, verify it, and return its link.
---

Apply before handing back a merged PR, including documentation-only changes. This is an agent merge-handoff workflow, not a GitHub Actions hook or scheduled job. It does not itself authorize merging a PR.

The owner has given standing authorization to refresh and publish the already-configured guild spreadsheet after a verified merge in this repository. Do not ask for the same publication permission again. A later instruction to skip publishing or work offline takes precedence. Do not change the spreadsheet target, sharing permissions, credentials, guild config, Discord mapping, or pinned recipe map merely to complete this workflow.

Read and use [refresh-roster](../refresh-roster/SKILL.md) for the operational rules, retention behavior, ownership checks and editable-note preservation.

## Run the landed code

- Confirm the PR is merged into this repository's main branch and identify the landed commit. A closed PR, green checks or an approval alone is not a merge.
- Sync main as authorized and use a clean checkout of the landed code (or newer main). Use the trusted checkout that already holds the private runtime files; keep it until publication and verification finish. Never move live credentials or guild data into public CI or synthetic test fixtures.
- Reuse the existing private config, Discord map, output directory, credentials through Varlock, and configured spreadsheet ID. The existing output snapshot supplies retained values and the full recipe map; do not switch to an empty output directory or run the synthetic demo as the real export.
- Complete one refresh/publish cycle for the landed revision. If this handoff already completed and verified that cycle, reuse its evidence and return the link rather than duplicating writes.

## Regenerate and publish

Run `just refresh` with the existing paths (defaults: `.local/roster.json` and `output/roster`). It regenerates the snapshot, XLSX and all CSV files using live guild discovery and the existing recipe-detail cache.

Handle the refresh result explicitly; do not blindly chain publishing with `&&`:

- **Exit 0:** continue after confirming a new snapshot was written by this run.
- **Exit 2:** validate the new partial snapshot, retain the component/status/last-success labels, and continue publishing it. Summarize incomplete components in the final response. Partial data is expected when individual character APIs are unavailable.
- **Exit 1 or an unexpected result:** stop publication. Do not publish an older snapshot as if it came from this run. Report the failure and link to the existing spreadsheet, clearly marked as not updated.

Before publishing, privately record editable notes by character identity and the manual tabs needed for the preservation comparison. Run `just sheets <output-directory>/snapshot.json` only for the newly regenerated snapshot. Preserve independent Player Notes (Editable) values and formats on Characters and Professions. Update only the five owned export tabs; Useful Info and Guides, Guide Suggestions (Manual), and other human tabs stay outside exporter ownership. Do not recreate or repopulate the one-time guide suggestions.

On an ownership/note-preservation error, stop and report it; do not bypass the guard. A Google write uses one atomic batch without retries. If its outcome is ambiguous, inspect the live workbook before deciding whether any further write is necessary; do not replay it blindly.

## Verify and return the link

Read back the live workbook after a successful write. Confirm the five owned tab names/order, current headers and row counts, and Guild Info's Generated At against the new snapshot. Check that editable notes still follow character identities and manual tabs remain unchanged, using a private pre-publish read when comparison is needed. Save any detailed evidence only under ignored private paths; report counts and outcomes rather than note text or raw roster rows.

End the handoff with a clickable link constructed from the validated configured spreadsheet ID:

`https://docs.google.com/spreadsheets/d/<configured-spreadsheet-id>/edit`

State whether regeneration, publication and readback verification succeeded; include the refresh time and any partial-data limitations. If a stage failed, still supply the existing spreadsheet link when available, with an accurate freshness statement. Do not claim a refresh succeeded merely because the PR merged or local exports exist.
