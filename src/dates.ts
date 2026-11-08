import { z } from "zod";
import { SafeError } from "./http.ts";

export interface RelativeDate {
  row: number;
  column: number;
  timestamp: string;
}

function dateParts(
  timestamp: string,
  timeZone: string,
): [number, number, number] {
  const parsed = z.iso.datetime().safeParse(timestamp);
  if (!parsed.success) throw new SafeError("Invalid last-login timestamp.");
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(new Date(parsed.data));
    const part = (type: string) =>
      Number(parts.find((p) => p.type === type)?.value);
    const result: [number, number, number] = [
      part("year"),
      part("month"),
      part("day"),
    ];
    if (
      result.some((n) => !Number.isInteger(n)) ||
      result[0] < 1900 ||
      result[0] > 9999
    )
      throw new Error();
    return result;
  } catch {
    throw new SafeError("Unsupported last-login date or display timezone.");
  }
}

export function relativeLogin(
  timestamp: string,
  viewedAt: string,
  timeZone = "UTC",
): string {
  const event = dateParts(timestamp, timeZone),
    today = dateParts(viewedAt, timeZone);
  const days = Math.round(
    (Date.UTC(today[0], today[1] - 1, today[2]) -
      Date.UTC(event[0], event[1] - 1, event[2])) /
      86_400_000,
  );
  return days < 0
    ? "Future date"
    : days === 0
      ? "Today"
      : `${days} ${days === 1 ? "day" : "days"} ago`;
}

// Only numeric date parts enter this fixed formula. API/config strings never
// become spreadsheet code. Sheets uses its timezone. XLSX/CSV show static UTC labels.
export function relativeLoginFormula(
  timestamp: string,
  timeZone = "UTC",
): string {
  const date = `DATE(${dateParts(timestamp, timeZone).join(",")})`;
  const days = `(TODAY()-${date})`;
  return `IF(${days}<0,"Future date",IF(${days}=0,"Today",IF(${days}=1,"1 day ago",${days}&" days ago")))`;
}

export function validatedRelativeDates(table: {
  name: string;
  rows: readonly (readonly (string | number)[])[];
  relativeDates?: readonly RelativeDate[];
}): readonly RelativeDate[] {
  const dates = table.relativeDates ?? [];
  const cells = new Set<string>();
  for (const date of dates) {
    const key = `${date.row}:${date.column}`;
    if (
      table.name !== "Characters" ||
      !Number.isInteger(date.row) ||
      date.row < 1 ||
      date.row >= table.rows.length ||
      !Number.isInteger(date.column) ||
      date.column < 0 ||
      table.rows[0]?.[date.column] !== "Last Login" ||
      table.rows[date.row]?.[
        table.rows[0]?.indexOf("Last Login (UTC)") ?? -1
      ] !== date.timestamp ||
      cells.has(key)
    )
      throw new SafeError("Invalid relative last-login cell.");
    relativeLoginFormula(date.timestamp);
    cells.add(key);
  }
  return dates;
}
