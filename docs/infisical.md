# Move from local Varlock files to self-hosted Infisical

The app reads the same environment contract regardless of where Varlock resolves values. Local `.env.local` is the initial implementation. Infisical provisioning, private addresses, project IDs, identity credentials and trusted network access belong to the homelab project and are deliberately absent here. The selected storage scope is a dedicated project `wow-forever-guild-report`, environment `prod`, path `/runtime`, with keys `BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET`. Saving those credentials and enabling runtime resolution are separate operations: this repository does not provision infrastructure or automatically enable an Infisical resolver.

Provisioning and initial writes require an owner admin session or an app-only writer identity. Never reuse a shared pilot project's identity as this app's runtime access. Create only missing keys, refuse conflicting existing values, and verify exact readback without printing values before removing temporary handoff files. Homelab guidance recommends separate development/production access, read-only runtime identities and token lifetimes targeting 15 minutes or less.

Before connecting, establish the instance's trusted HTTPS endpoint, CA trust, reachable runner, project/environment/path, and a dedicated **read-only** machine identity scoped to this application's secrets. Keep development and production access separate. Do not disable TLS verification or expose the instance publicly for this CLI. Prefer short-lived/OIDC machine identity credentials where the runner and homelab support them; Universal Auth is a practical bootstrap alternative.

The [native Varlock Infisical plugin](https://varlock.dev/plugins/infisical/) supports a custom `siteUrl`, Universal Auth, OIDC, and path-scoped resolution. Once the homelab contract is agreed, pin its package version with Bun and keep the version in `bun.lock`. Add its root decorators to `.env.schema`, keeping all bootstrap values private. Example structure (placeholders only; not active configuration):

```dotenv
# @plugin(@varlock/infisical-plugin)
# @initInfisical(projectId=$INFISICAL_PROJECT_ID, environment=$INFISICAL_ENVIRONMENT, clientId=$INFISICAL_CLIENT_ID, clientSecret=$INFISICAL_CLIENT_SECRET, siteUrl=$INFISICAL_SITE_URL, secretPath=/runtime)
# @defaultRequired=false
# @defaultSensitive=true
# ---

# @internal
INFISICAL_PROJECT_ID=
# @internal
INFISICAL_ENVIRONMENT=
# @internal
INFISICAL_SITE_URL=
# @type=infisicalClientId @internal
INFISICAL_CLIENT_ID=
# @type=infisicalClientSecret @sensitive @internal
INFISICAL_CLIENT_SECRET=

BLIZZARD_CLIENT_ID=infisical()
BLIZZARD_CLIENT_SECRET=infisical()
```

Use the selected project/environment/path above for production; confirm any separate development scope with the homelab owner. Keep `DISCORD_MAP_FILE` local; a secret store does not need to hold the mapping or public workbook. For Google, prefer an injected short-lived token or a privately delivered service-account file over embedding JSON keys into public schema defaults.

Validate a scoped read with Varlock and run a guild refresh on the trusted runner. Confirm log redaction, no bootstrap secret reaches the app, restrictive local permissions, rotation, revocation and failure behavior. Resolver authentication/network errors must fail visibly, without silently falling back to stale local credentials. Remove migrated app values from `.env.local` and rotate superseded credentials after confirming the new path.

Keep offline tests/demo free of network-bound resolvers: use local file mode or an explicitly isolated test schema. Do not make public CI depend on private homelab connectivity. Any caching/frozen-environment design needs an explicit expiry, private storage, and visible freshness semantics; it is not enabled by this project.

An existing Infisical CLI deployment can instead inject values into `varlock run`, preserving Varlock validation/redaction, if that is the homelab's maintained interface. Neither mechanism needs application source changes. Do not add two independent secret resolvers to the app.
