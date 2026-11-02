// GoTime is the time.Time a YAML timestamp decodes to in yaml.v3: a wall
// clock in UTC or in a fixed zone of the given offset (time.FixedZone with
// an empty name).

export class GoTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly nanosecond: number;
  // offset in seconds east of UTC; null for the UTC location.
  readonly offset: number | null;

  constructor(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    nanosecond: number,
    offset: number | null,
  ) {
    this.year = year;
    this.month = month;
    this.day = day;
    this.hour = hour;
    this.minute = minute;
    this.second = second;
    this.nanosecond = nanosecond;
    this.offset = offset;
  }

  // string is Time.String: "2006-01-02 15:04:05.999999999 -0700 MST".
  string(): string {
    const off = this.offset ?? 0;
    const zone = this.offset === null ? "UTC" : numericZone(off, false);
    return `${this.date()} ${this.clock()}${fraction(this.nanosecond)} ${numericZone(off, false)} ${zone}`;
  }

  date(): string {
    return `${pad(this.year, 4)}-${pad(this.month, 2)}-${pad(this.day, 2)}`;
  }

  clock(): string {
    return `${pad(this.hour, 2)}:${pad(this.minute, 2)}:${pad(this.second, 2)}`;
  }
}

// formatRFC3339Nano is Format(time.RFC3339Nano).
export function formatRFC3339Nano(t: GoTime): string {
  const zone = t.offset === null ? "Z" : numericZone(t.offset, true);
  return `${t.date()}T${t.clock()}${fraction(t.nanosecond)}${zone}`;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

// fraction is ".999999999": the nanoseconds without trailing zeros, nothing
// when they are zero.
function fraction(ns: number): string {
  if (ns === 0) return "";
  return "." + pad(ns, 9).replace(/0+$/, "");
}

function numericZone(offset: number, colon: boolean): string {
  const sign = offset < 0 ? "-" : "+";
  const m = Math.floor(Math.abs(offset) / 60);
  return `${sign}${pad(Math.floor(m / 60), 2)}${colon ? ":" : ""}${pad(m % 60, 2)}`;
}
