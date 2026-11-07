import { configSchema, manualSnapshot } from "../src/model.ts";
import type { RosterSource } from "../src/roster.ts";

export const now = new Date("2026-11-07T16:00:00.000Z");
export const config = configSchema.parse({
  version: 1,
  region: "us",
  guild: "example-guild",
  characters: [
    {
      slug: "example-priest",
      name: "Example Priest",
      primary: [{ name: "Alchemy", skill: 50, max: 75 }],
    },
  ],
});
export const snapshot = manualSnapshot(
  config,
  { "us:example-priest": "example_discord" },
  now,
);
export function source(overrides: Partial<RosterSource> = {}): RosterSource {
  return {
    guild: async () => [],
    profile: async () => ({ level: 17, class: "Priest" }),
    professions: async () => ({
      primary: [{ name: "Alchemy", skill: 72, max: 150 }],
      secondary: [{ name: "Cooking", skill: 20, max: 75 }],
    }),
    talents: async () => ({
      talents: [
        { tree: "Shadow Magic", points: 5 },
        { tree: "Discipline", points: 2 },
      ],
    }),
    ...overrides,
  };
}
