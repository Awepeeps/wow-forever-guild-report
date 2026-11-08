import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { z } from "zod";
import { SafeError } from "./http.ts";
import type { Snapshot } from "./model.ts";
import { buildTables, toCsv, toXlsx } from "./workbook.ts";

export async function readJson<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new SafeError(
      "Cannot read JSON input. Check the file path, permissions, and JSON syntax.",
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Schema paths are safe; values and validation messages may include private inputs.
    const paths = parsed.error.issues
      .slice(0, 5)
      .map((i) => i.path.join(".") || "root")
      .join(", ");
    throw new SafeError(
      `Invalid JSON structure at: ${paths}. See README for the schema.`,
    );
  }
  return parsed.data;
}

export async function atomicWrite(
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(content);
    } finally {
      await file.close();
    }
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

export async function writeExports(
  snapshot: Snapshot,
  directory: string,
): Promise<void> {
  const tables = buildTables(snapshot);
  for (const table of tables)
    await atomicWrite(
      join(directory, `${table.name.toLowerCase().replaceAll(" ", "-")}.csv`),
      toCsv(
        table.rows.map((row, i) =>
          i === 0 && table.name === "Characters"
            ? row.map((cell) =>
                cell === "Last Login" ? "Last Login (at export)" : cell,
              )
            : row,
        ),
      ),
    );
  await atomicWrite(join(directory, "roster.xlsx"), toXlsx(tables));
  await atomicWrite(
    join(directory, "snapshot.json"),
    `${JSON.stringify(snapshot, null, 2)}\n`,
  );
}
