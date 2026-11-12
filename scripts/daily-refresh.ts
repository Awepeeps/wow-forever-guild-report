import { mkdir, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, readJson } from "../src/files.ts";
import { SafeError } from "../src/http.ts";
import { snapshotSchema } from "../src/model.ts";

type Run = (args: string[]) => Promise<number>;

const runJust: Run = async (args) => {
  const process = Bun.spawn(["just", ...args], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return process.exited;
};

// The caller holds the same flock for the entire refresh/publication cycle.
export async function dailyRefresh({
  config = ".local/roster.json",
  out = "output/roster",
  run = runJust,
  now = Date.now,
}: {
  config?: string;
  out?: string;
  run?: Run;
  now?: () => number;
} = {}): Promise<0 | 2> {
  const path = join(out, "snapshot.json");
  const pending = join(out, "publication-pending.json");
  if (await Bun.file(pending).exists())
    throw new SafeError(
      "An earlier publication needs inspection. Check the live sheet before removing output/roster/publication-pending.json; no refresh or write was attempted.",
    );

  const previous = (await Bun.file(path).exists())
    ? await readJson(path, snapshotSchema)
    : undefined;
  if (previous) {
    const backups = join(out, "backups");
    const name = `snapshot-${previous.generatedAt.replaceAll(/[:.]/g, "-")}.json`;
    await atomicWrite(
      join(backups, name),
      `${JSON.stringify(previous, null, 2)}\n`,
    );
    const names = (await readdir(backups))
      .filter((entry) =>
        /^snapshot-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/.test(entry),
      )
      .sort();
    for (const old of names.slice(0, -14)) await unlink(join(backups, old));
  }

  const started = now();
  const code = await run(["refresh", config, out]);
  if (code !== 0 && code !== 2)
    throw new SafeError("Daily refresh failed; Google Sheets was not updated.");

  const current = await readJson(path, snapshotSchema);
  const generated = Date.parse(current.generatedAt);
  if (
    generated < started ||
    generated > now() ||
    (previous && generated <= Date.parse(previous.generatedAt))
  )
    throw new SafeError(
      "Refresh did not produce a new snapshot for this run; Google Sheets was not updated.",
    );
  if (current.guild && current.rows.length === 0)
    throw new SafeError(
      "Guild discovery returned an empty roster; Google Sheets was not updated.",
    );

  // An interruption, timeout, or any failed publication leaves this marker.
  // Later unattended runs must not replay a potentially committed Google write.
  await mkdir(out, { recursive: true, mode: 0o700 });
  const marker = await open(pending, "wx", 0o600);
  try {
    await marker.writeFile(
      `${JSON.stringify({ generatedAt: current.generatedAt })}\n`,
    );
  } finally {
    await marker.close();
  }
  const published = await run(["sheets", path]);
  if (published !== 0)
    throw new SafeError(
      "Google publication failed and will not be retried automatically. Inspect the live sheet and publication-pending.json before another write.",
    );
  await unlink(pending);
  console.log(
    `Daily refresh published ${current.rows.length} characters; generated ${current.generatedAt}; ${code === 2 ? "partial API data (failed components labelled)" : "complete API data"}.`,
  );
  return code;
}

if (import.meta.main) {
  try {
    process.exitCode = await dailyRefresh();
  } catch (error) {
    console.error(
      error instanceof SafeError
        ? error.message
        : "Daily job failed. Check private file permissions and configuration; private error details were suppressed.",
    );
    process.exitCode = 1;
  }
}
