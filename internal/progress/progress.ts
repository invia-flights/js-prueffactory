// The plain, timestamped progress lines of a Run on stderr. The lines have no
// ANSI codes and need no TTY.

import type { Writable } from "node:stream";

import { formatRFC3339 } from "../gocompat/json.ts";

export class Logger {
  readonly #w: Writable;
  readonly #now: () => Date;

  /** A Logger that writes to w. Without a clock it uses the current time. */
  constructor(w: Writable, now: () => Date = () => new Date()) {
    this.#w = w;
    this.#now = now;
  }

  /**
   * print writes one line: a UTC timestamp, a space and the message (Go's
   * Printf with the message already formatted). Control characters, including
   * escape sequences, are replaced so text from the project can never move
   * the cursor or colour the terminal.
   */
  print(message: string): void {
    // eslint-disable-next-line no-control-regex
    const clean = message.replace(/[\x00-\x1f\x7f]/g, " ");
    this.#w.write(`${formatRFC3339(this.#now())} ${clean}\n`);
  }
}
