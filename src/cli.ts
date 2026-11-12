import "varlock/auto-load";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { refreshAuctionPrices } from "./auctions.ts";
import { BlizzardClient } from "./blizzard.ts";
import { refreshItemVendorPrices, refreshRecipeDetails } from "./crafting.ts";
import { atomicWrite, readJson, writeExports } from "./files.ts";
import { ApiError, SafeError } from "./http.ts";
import { importCsv } from "./import.ts";
import {
  configSchema,
  discordMapSchema,
  hasRetainedRecipes,
  manualSnapshot,
  recipeMappingSchema,
  regionSchema,
  snapshotSchema,
} from "./model.ts";
import { downloadRecipeMapping, withRecipeMapping } from "./recipe-mapping.ts";
import { refreshRoster } from "./roster.ts";
import { googleToken, publishSheets } from "./sheets.ts";
import { buildTables } from "./workbook.ts";

const help = `WoW Forever Guild Report — guild profession workbooks (Bun + Varlock)

  just demo
  just refresh [config] [output-directory]
  just export [config] [output-directory]   Offline, supplied data only
  just import-csv input.csv [output.json]   Writes config and sibling discord-map.json
  just sheets [snapshot.json]              Updates five tool-owned tabs; preserves Player Notes (Editable)
  just recipe-map <client-build> [output.json]   Imports a pinned recipe → spell table

Direct CLI: bun run cli <refresh|export|import|sheets|recipe-map> [options]
  --config .local/roster.json   --out output/roster
  --input roster.csv          --region us
  --snapshot output/roster/snapshot.json
  --recipe-map .local/recipe-map.json      Optional for refresh/export; retained in snapshots
  --build 1.60.1.70862                    Required for recipe-map

Secrets: .env.local via Varlock; Discord mapping: DISCORD_MAP_FILE.
Refresh exit 2 means partial data exported; 1 means the command failed.
`;

async function main(): Promise<void> {
  let args: ReturnType<
    typeof parseArgs<{
      options: {
        config: { type: "string" };
        out: { type: "string" };
        input: { type: "string" };
        region: { type: "string" };
        snapshot: { type: "string" };
        "recipe-map": { type: "string" };
        build: { type: "string" };
        help: { type: "boolean" };
      };
      allowPositionals: true;
    }>
  >;
  try {
    args = parseArgs({
      args: Bun.argv.slice(2),
      allowPositionals: true,
      options: {
        config: { type: "string" },
        out: { type: "string" },
        input: { type: "string" },
        region: { type: "string" },
        snapshot: { type: "string" },
        "recipe-map": { type: "string" },
        build: { type: "string" },
        help: { type: "boolean" },
      },
    });
  } catch {
    throw new SafeError("Invalid CLI arguments. Run bun run cli --help.");
  }
  const { values, positionals } = args;
  const command = positionals[0];
  if (values.help || !command) {
    console.log(help);
    return;
  }
  if (positionals.length !== 1)
    throw new SafeError("Use named options for CLI paths. See --help.");
  if (command === "recipe-map") {
    if (!values.build) throw new SafeError("Recipe mapping requires --build.");
    const path = values.out ?? ".local/recipe-map.json";
    if (await Bun.file(path).exists())
      throw new SafeError(
        "Recipe mapping output already exists. Choose a new path to preserve the pinned mapping.",
      );
    const mapping = await downloadRecipeMapping(values.build);
    await atomicWrite(path, `${JSON.stringify(mapping, null, 2)}\n`);
    console.log(
      `Imported ${Object.keys(mapping.spells).length} recipe-to-spell mappings for Forever build ${mapping.build}.`,
    );
    return;
  }
  if (command === "import") {
    if (!values.input) throw new SafeError("Import requires --input CSV path.");
    let csv: string;
    try {
      csv = await readFile(values.input, "utf8");
    } catch {
      throw new SafeError("Cannot read input CSV.");
    }
    const region = regionSchema.safeParse(values.region ?? "us");
    if (!region.success)
      throw new SafeError("Region must be us, eu, kr, or tw.");
    const imported = importCsv(csv, region.data);
    const path = values.out ?? ".local/roster.json";
    const mappingPath = join(dirname(path), "discord-map.json");
    // Import is a migration operation. Never overwrite private mappings or config accidentally.
    if (
      (await Bun.file(path).exists()) ||
      (await Bun.file(mappingPath).exists())
    )
      throw new SafeError(
        "Import output already exists. Choose a new private directory to avoid overwriting mappings.",
      );
    await atomicWrite(path, `${JSON.stringify(imported.config, null, 2)}\n`);
    await atomicWrite(
      mappingPath,
      `${JSON.stringify(imported.discord, null, 2)}\n`,
    );
    console.log(
      `Imported ${imported.config.characters.length} characters. Set DISCORD_MAP_FILE to the sibling discord-map.json.`,
    );
    return;
  }
  if (command === "sheets") {
    const snapshot = await readJson(
      values.snapshot ?? "output/roster/snapshot.json",
      snapshotSchema,
    );
    const id = process.env.GOOGLE_SPREADSHEET_ID;
    if (!id)
      throw new SafeError(
        "Set GOOGLE_SPREADSHEET_ID in Varlock configuration.",
      );
    await publishSheets(
      buildTables(snapshot),
      id,
      await googleToken(process.env),
    );
    console.log(
      "Published Characters, Professions, Recipes, Guild Info, and Automated Export Info; preserved Player Notes (Editable).",
    );
    return;
  }
  if (command !== "refresh" && command !== "export")
    throw new SafeError("Unknown command. See --help.");
  const config = await readJson(
    values.config ?? ".local/roster.json",
    configSchema,
  );
  const mapPath = process.env.DISCORD_MAP_FILE;
  const map = mapPath ? await readJson(mapPath, discordMapSchema) : {};
  const outputDirectory =
    values.out ?? (command === "export" ? "output/export" : "output/roster");
  const previousPath = join(outputDirectory, "snapshot.json");
  const previous = (await Bun.file(previousPath).exists())
    ? await readJson(previousPath, snapshotSchema)
    : undefined;
  const recipeMapping = values["recipe-map"]
    ? await readJson(values["recipe-map"], recipeMappingSchema)
    : previous?.recipeMapping;
  if (
    command === "export" &&
    previous?.rows.some((row) =>
      [row.profileStatus, row.professionStatus, row.talentStatus].some(
        (status) => status !== "manual",
      ),
    )
  )
    throw new SafeError(
      "Offline export cannot replace an API refresh snapshot. Choose a separate output directory.",
    );
  let snapshot = manualSnapshot(config, map);
  if (command === "refresh") {
    const clientId = process.env.BLIZZARD_CLIENT_ID;
    const clientSecret = process.env.BLIZZARD_CLIENT_SECRET;
    if (!clientId || !clientSecret)
      throw new SafeError(
        "Refresh requires BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET in Varlock configuration.",
      );
    const client = new BlizzardClient(config, { clientId, clientSecret });
    snapshot = await refreshRoster(config, map, client, new Date(), previous);
    if (recipeMapping) snapshot = withRecipeMapping(snapshot, recipeMapping);
    snapshot = await refreshRecipeDetails(snapshot, client, previous);
    snapshot = await refreshItemVendorPrices(snapshot, client, previous);
    snapshot = await refreshAuctionPrices(snapshot, client, previous);
  }
  if (recipeMapping) snapshot = withRecipeMapping(snapshot, recipeMapping);
  await writeExports(snapshot, outputDirectory);
  const incomplete = snapshot.rows.filter(
    (r) =>
      hasRetainedRecipes(r.character) ||
      [r.profileStatus, r.professionStatus, r.talentStatus].some(
        (s) => s === "unavailable" || s === "error",
      ),
  ).length;
  const metadataEntries = Object.values(snapshot.recipeDetails ?? {});
  const metadataFailures = metadataEntries.filter(
    (entry) => entry.status !== "ok",
  ).length;
  const vendorEntries = Object.values(snapshot.itemVendor ?? {});
  const vendorFailures = vendorEntries.filter(
    (entry) => entry.status !== "ok",
  ).length;
  console.log(
    `Exported ${snapshot.rows.length} characters; ${incomplete} with incomplete API data. Recipe details: ${metadataEntries.length - metadataFailures} successful responses, ${metadataFailures} unavailable or retained. Vendor prices: ${vendorEntries.length - vendorFailures} successful, ${vendorFailures} unavailable or retained. CSV, roster.xlsx, snapshot.json written.`,
  );
  if (snapshot.auctionMarket)
    console.log(
      `Auction prices: ${snapshot.auctionPrices?.status === "ok" ? "snapshot retrieved" : "unavailable or retained"}.`,
    );
  if (
    command === "refresh" &&
    (incomplete ||
      metadataFailures ||
      vendorFailures ||
      (snapshot.auctionMarket && snapshot.auctionPrices?.status !== "ok"))
  )
    process.exitCode = 2;
}

try {
  await main();
} catch (error) {
  if (error instanceof SafeError || error instanceof ApiError)
    console.error(error.message);
  else
    console.error(
      "Command failed. Check local file permissions and configuration. Private error details were suppressed.",
    );
  process.exitCode = 1;
}
