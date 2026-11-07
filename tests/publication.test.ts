import { expect, test } from "bun:test";
import { privatePath } from "../scripts/check-publication.ts";

test("publication guard blocks forcibly tracked secrets/data even when scanner excludes local runtime paths", () => {
  for (const path of [
    ".env",
    ".env.local",
    ".env.production",
    ".local/discord-map.json",
    "output/snapshot.json",
    "client.key",
    "google-credentials.json",
  ])
    expect(privatePath(path)).toBe(true);
  for (const path of [
    ".env.schema",
    ".env.example",
    "examples/discord-map.json",
    "src/model.ts",
  ])
    expect(privatePath(path)).toBe(false);
});
