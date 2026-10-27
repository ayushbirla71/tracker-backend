/** True if `zone` is an IANA time zone name this runtime knows (e.g. "Asia/Kolkata"). */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    // hourCycle h23 so midnight prints as 00, never 24
    f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(zone, f);
  }
  return f;
}

/**
 * Wall-clock time of an instant in the given zone as "YYYY-MM-DD HH:mm:ss", which spreadsheets read as a date and time.
 * Timestamps are stored and calculated in UTC; this is only for what people read in exports.
 */
export function formatInZone(date: Date, zone: string): string {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(zone).formatToParts(date)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Short label for column headers: "IST" for India, otherwise the zone name. */
export function zoneLabel(zone: string): string {
  return zone === 'Asia/Kolkata' || zone === 'Asia/Calcutta' ? 'IST' : zone;
}
