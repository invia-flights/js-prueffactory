// The formats whose judgement and error text the port takes from the Go
// build's validator (santhosh-tekuri/jsonschema/v6 format.go): date-time, date
// and time of RFC 3339. Ajv's own date-time accepts a space for the T, which
// the Go build rejected. Each check returns undefined for a valid value and
// Go's reason otherwise. Values are handled as UTF-8 bytes, as Go did.

/** goFormats maps a format name to its check. */
export const goFormats: Readonly<
  Record<string, ((value: string) => string | undefined) | undefined>
> = {
  "date-time": dateTime,
  date: (v) => date(bytes(v)),
  time: (v) => time(bytes(v)),
};

// bytes turns a string into a byte string: one character per UTF-8 byte.
function bytes(s: string): string {
  return Buffer.from(s, "utf8").toString("latin1");
}

function dateTime(value: string): string | undefined {
  const s = bytes(value);
  if (s.length < 20) {
    return "less than 20 characters long";
  }
  if (s[10] !== "t" && s[10] !== "T") {
    return "11th character must be t or T";
  }
  const d = date(s.slice(0, 10));
  if (d !== undefined) {
    return `invalid date element: ${d}`;
  }
  const t = time(s.slice(11));
  if (t !== undefined) {
    return `invalid time element: ${t}`;
  }
  return undefined;
}

// atoi is strconv.Atoi for the short fields of a time: an optional sign and
// decimal digits; undefined where Go returns an error.
function atoi(s: string): number | undefined {
  return /^[+-]?[0-9]+$/.test(s) ? Number(s) : undefined;
}

function time(str: string): string | undefined {
  if (str.length < 9) {
    return "less than 9 characters long";
  }
  if (str[2] !== ":" || str[5] !== ":") {
    return "missing colon in correct place";
  }
  const hms: number[] = [];
  for (const tok of [str.slice(0, 2), str.slice(3, 5), str.slice(6, 8)]) {
    const i = atoi(tok);
    if (i === undefined) {
      return "invalid hour/min/sec";
    }
    if (i < 0) {
      return "non-positive hour/min/sec";
    }
    hms.push(i);
  }
  let [h = 0, m = 0] = hms;
  const sec = hms[2] ?? 0;
  if (h > 23 || m > 59 || sec > 60) {
    return "hour/min/sec out of range";
  }
  str = str.slice(8);

  if (str.startsWith(".")) {
    const rem = str.slice(1);
    let n = 0;
    while (n < rem.length && /[0-9]/.test(rem.charAt(n))) {
      n++;
    }
    if (n === 0) {
      return "no digits in second fraction";
    }
    str = rem.slice(n);
  }

  if (str !== "z" && str !== "Z") {
    if (str.length !== 6) {
      return "offset must be 6 characters long";
    }
    let sign: number;
    switch (str[0]) {
      case "+":
        sign = -1;
        break;
      case "-":
        sign = 1;
        break;
      default:
        return "offset must begin with plus/minus";
    }
    str = str.slice(1);
    if (str[2] !== ":") {
      return "missing colon in offset in correct place";
    }
    const zhm: number[] = [];
    for (const tok of [str.slice(0, 2), str.slice(3)]) {
      const i = atoi(tok);
      if (i === undefined) {
        return "invalid hour/min in offset";
      }
      if (i < 0) {
        return "non-positive hour/min in offset";
      }
      zhm.push(i);
    }
    const [zh = 0, zm = 0] = zhm;
    if (zh > 23 || zm > 59) {
      return "hour/min in offset out of range";
    }
    let hm = h * 60 + m + sign * (zh * 60 + zm);
    if (hm < 0) {
      hm += 24 * 60;
    }
    h = Math.trunc(hm / 60);
    m = hm % 60;
  }

  if (sec >= 60 && (h !== 23 || m !== 59)) {
    return "invalid leap second";
  }
  return undefined;
}

// date is time.Parse("2006-01-02", s): undefined when it parses, else the
// text of Go's *time.ParseError.
function date(s: string): string | undefined {
  const layout = "2006-01-02";
  const cannot = (valueElem: string, layoutElem: string) =>
    `parsing time ${timeQuote(s)} as ${timeQuote(layout)}: cannot parse ${timeQuote(valueElem)} as ${timeQuote(layoutElem)}`;
  const outOfRange = (what: string) =>
    `parsing time ${timeQuote(s)}: ${what} out of range`;

  let value = s;
  // Go's stdLongYear wants a digit first, so a sign is not a year.
  if (value.length < 4 || !/^[0-9]/.test(value)) {
    return cannot(value, "2006");
  }
  const year = atoiTime(value.slice(0, 4));
  if (year === undefined) {
    return cannot(value, "2006");
  }
  value = value.slice(4);
  if (!value.startsWith("-")) {
    return cannot(value, "-");
  }
  value = value.slice(1);
  const month = twoDigits(value);
  if (month === undefined) {
    return cannot(value, "01");
  }
  if (month < 1 || month > 12) {
    return outOfRange("month");
  }
  value = value.slice(2);
  if (!value.startsWith("-")) {
    return cannot(value, "-");
  }
  value = value.slice(1);
  const day = twoDigits(value);
  if (day === undefined) {
    return cannot(value, "02");
  }
  if (day > 31) {
    return outOfRange("day");
  }
  value = value.slice(2);
  if (value.length > 0) {
    return `parsing time ${timeQuote(s)}: extra text: ${timeQuote(value)}`;
  }
  if (day < 1 || day > daysIn(month, year)) {
    return outOfRange("day");
  }
  return undefined;
}

// atoiTime is the time package's atoi: an optional sign, then digits up to
// the end.
function atoiTime(s: string): number | undefined {
  return /^[+-]?[0-9]*$/.test(s) ? Number(s.replace(/^[+-]$/, "0")) : undefined;
}

// twoDigits is the time package's getnum(s, true).
function twoDigits(s: string): number | undefined {
  return /^[0-9]{2}/.test(s) ? Number(s.slice(0, 2)) : undefined;
}

function daysIn(month: number, year: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// timeQuote is the time package's quote of a byte string: bytes that are not
// printable ASCII are written as \xNN.
function timeQuote(s: string): string {
  let out = '"';
  for (const c of s) {
    const b = c.charCodeAt(0);
    if (b >= 0x80 || b < 0x20) {
      out += "\\x" + b.toString(16).padStart(2, "0");
    } else {
      if (c === '"' || c === "\\") {
        out += "\\";
      }
      out += c;
    }
  }
  return out + '"';
}
