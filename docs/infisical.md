# Loading secrets from self-hosted Infisical

The app reads one environment contract (`.env.schema`) regardless of where Varlock resolves values. By default, values come from the private `.env.local`. A machine can opt into Infisical instead, using the pinned [Varlock Infisical plugin](https://varlock.dev/plugins/infisical/) (`@varlock/infisical-plugin`, exact version in `package.json`/`bun.lock`).

Infisical provisioning, private addresses, project IDs and identity credentials belong to the homelab project and are deliberately absent here. This repository never provisions infrastructure.

## Scope

| Item        | Value                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| Project     | dedicated `wow-forever-guild-report`                                                                   |
| Environment | `prod` (`INFISICAL_ENVIRONMENT`, default `prod`)                                                       |
| Path        | `/runtime` (fixed in `.env.schema`)                                                                    |
| Keys        | `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_SPREADSHEET_ID` |
| Stays local | `DISCORD_MAP_FILE` and the mapping, roster config, exports                                             |

`GOOGLE_SERVICE_ACCOUNT_JSON` is the service-account key as compact one-line JSON. It takes precedence over `GOOGLE_SERVICE_ACCOUNT_FILE`, so no key file needs to exist on disk.

Writes (enrollment and initial saves) use a separate, short-lived app-only writer identity held by the homelab project. The app itself uses only a **read-only** runtime machine identity limited to this project, environment and path. Never reuse a shared pilot identity or the writer as the runtime identity. Self-hosted Infisical without Enterprise cannot scope a role to one environment or path, so the runtime identity is a project Viewer: keep this project's other environments empty and store nothing else in it.

## Opting in on a machine

The plugin is initialized in `.env.schema` but stays inactive while the bootstrap values are empty, so CI, `just demo` and offline exports never contact Infisical. To opt in, set the bootstrap values in the private `.env.local` and switch each migrated key to the resolver:

```dotenv
INFISICAL_SITE_URL=https://<trusted-tailnet-host>:<port>
INFISICAL_PROJECT_ID=<project id>
INFISICAL_CLIENT_ID=<runtime identity client id>
INFISICAL_CLIENT_SECRET=<runtime identity client secret>

BLIZZARD_CLIENT_ID=infisical()
BLIZZARD_CLIENT_SECRET=infisical()
GOOGLE_SERVICE_ACCOUNT_JSON=infisical()
GOOGLE_SPREADSHEET_ID=infisical()
GOOGLE_SERVICE_ACCOUNT_FILE=
```

`INFISICAL_*` items are `@internal`: Varlock uses them to authenticate but does not pass them to the app process. Keep `.env.local` at mode 0600.

Then run `just env-check` (values stay redacted) and `just refresh`. A resolver failure (network, TLS, authentication, permission or a missing key) makes Varlock report the invalid item and stop before the app starts. There is deliberately no fallback to local values, so a broken secret path cannot silently use stale credentials.

## Requirements and cutover

- Use the instance's trusted HTTPS endpoint on the tailnet. Do not disable TLS verification or expose the instance publicly for this CLI.
- Keep Universal Auth access-token lifetimes short (the homelab guidance targets 15 minutes or less) and keep development and production access separate.
- Confirm a scoped read with `just env-check`, then a guild refresh and, if needed, a Sheets publish.
- Only then remove the migrated values and local key files (`.local/google-service-account.json`, staged handoff copies), and consider rotating superseded credentials.
- Keep offline tests and the demo free of network-bound resolvers. Public CI must never depend on private homelab connectivity.
- Do not add a second secret resolver, such as an Infisical CLI wrapper around `varlock run`, alongside the plugin.
