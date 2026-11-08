---

name: verify-forever-api
description: Research or validate WoW Forever Blizzard API routes, response schemas, professions, or talent distributions when the isolated adapter changes.
---

Read `src/blizzard.ts`, `tests/blizzard.test.ts`, and README's API status before changing assumptions. Forever launched in November 2026; older Retail/Classic knowledge does not establish its support.

Start with Blizzard developer documentation. When undocumented, distinguish Blizzard-authored contracts from community reports and live observations. The references currently used are the [Forever API forum post](https://us.forums.blizzard.com/en/blizzard/t/wow-forever-api-what-works-so-far-plus-a-ts-client/60334) and [client author's source](https://github.com/Pinta365/blizzard_api/tree/main/src/wow_forever). Check their current revision; do not copy a response blindly.

Use `profile-forever-{region}` and realmless guild/character paths. Prefer the roster's character IDs/slugs. For talents, inspect `specialization_groups`, `is_active`, `specializations`, and `spent_points`; each tree is not a separate spec label. Distinguish missing empty arrays from an unsupported overall shape. Keep active groups separate. For professions, preserve all tiers, raw skill/max, all secondaries and known_recipes IDs/names. Missing known_recipes means unknown, while [] is known empty. At roster merge, missing lists retain recipes only for the same profession/tier with their original recipe-specific success time and visible stale status; [] clears the prior list. Strip response key.href references; never follow arbitrary response URLs. Profile metrics are optional; convert positive last_login_timestamp epoch milliseconds to UTC and leave missing/zero timestamps unknown. XP remains the raw experience field with no lifetime/progress inference.

Live probes require existing authorization and credentials supplied through Varlock. Use API calls only, never Armory HTML extraction. Save any necessary evidence under ignored `.local/` with private permissions; report only shapes, status codes and aggregate counts. Sanitize new fixtures into invented characters/IDs, omit credentials/links/tokens, and test the sanitized contract. Never commit a real response.

A 404 is unavailable/unpublished, not proof of absence. Auth/guild errors must not become successful empty rosters. Add runtime validation and behavior tests for any newly accepted shape. Clearly label what was tested against fixtures and what was tested live, including the date/region.
