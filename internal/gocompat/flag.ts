// Go's flag package as a FlagSet with ContinueOnError and no output: one or
// two dashes, "-flag value" and "-flag=value", boolean flags only as "-flag"
// or "-flag=value", parsing stops at the first non-flag or after "--", and
// -h/-help ask for help when no such flag is defined. Errors carry Go's text.

import { quote } from "./fmt.ts";
import { errorMessage } from "./errors.ts";

/** ErrHelp is thrown by parse for -h or -help, like Go's flag.ErrHelp. */
export const ErrHelp = new Error("flag: help requested");

interface Flag {
  readonly isBool: boolean;
  // set throws an Error whose message Go's flag package would append.
  set(value: string): void;
}

/** A flag value the FlagSet writes to. */
export interface Ref<T> {
  value: T;
}

// strconv.ParseBool
const boolValues = new Map<string, boolean>([
  ["1", true],
  ["t", true],
  ["T", true],
  ["TRUE", true],
  ["true", true],
  ["True", true],
  ["0", false],
  ["f", false],
  ["F", false],
  ["FALSE", false],
  ["false", false],
  ["False", false],
]);

export class FlagSet {
  readonly #formal = new Map<string, Flag>();
  readonly #actual = new Set<string>();
  #args: string[] = [];

  /** string defines a string flag; a repeated flag keeps the last value. */
  string(name: string, defaultValue: string): Ref<string> {
    const ref = { value: defaultValue };
    this.#formal.set(name, {
      isBool: false,
      set: (v) => {
        ref.value = v;
      },
    });
    return ref;
  }

  /** bool defines a boolean flag, set by "-name" or "-name=<ParseBool value>". */
  bool(name: string, defaultValue: boolean): Ref<boolean> {
    const ref = { value: defaultValue };
    this.#formal.set(name, {
      isBool: true,
      set: (v) => {
        const parsed = boolValues.get(v);
        // Go's boolValue.Set stores false before it reports the error.
        ref.value = parsed ?? false;
        if (parsed === undefined) {
          throw new Error("parse error");
        }
      },
    });
    return ref;
  }

  /** func defines a flag that calls set with every value given (flag.Var). */
  func(name: string, set: (value: string) => void): void {
    this.#formal.set(name, { isBool: false, set });
  }

  /** isSet says whether the flag was given (what flag.Visit visits). */
  isSet(name: string): boolean {
    return this.#actual.has(name);
  }

  /** args are the arguments left after the flags. */
  args(): string[] {
    return [...this.#args];
  }

  /**
   * parse reads flags from the start of args until the first non-flag or
   * "--". It throws ErrHelp or an Error with Go's message.
   */
  parse(args: readonly string[]): void {
    this.#args = [...args];
    while (this.#parseOne()) {
      // next flag
    }
  }

  #parseOne(): boolean {
    const s = this.#args[0];
    if (s === undefined || s.length < 2 || !s.startsWith("-")) {
      return false;
    }
    let minuses = 1;
    if (s.charAt(1) === "-") {
      minuses = 2;
      if (s.length === 2) {
        this.#args = this.#args.slice(1);
        return false;
      }
    }
    let name = s.slice(minuses);
    if (name === "" || name.startsWith("-") || name.startsWith("=")) {
      throw new Error(`bad flag syntax: ${s}`);
    }
    this.#args = this.#args.slice(1);
    let hasValue = false;
    let value = "";
    const eq = name.indexOf("=", 1);
    if (eq > 0) {
      value = name.slice(eq + 1);
      hasValue = true;
      name = name.slice(0, eq);
    }

    const flag = this.#formal.get(name);
    if (flag === undefined) {
      if (name === "help" || name === "h") {
        throw ErrHelp;
      }
      throw new Error(`flag provided but not defined: -${name}`);
    }

    if (flag.isBool) {
      const v = hasValue ? value : "true";
      try {
        flag.set(v);
      } catch (err) {
        throw new Error(
          hasValue
            ? `invalid boolean value ${quote(v)} for -${name}: ${errorMessage(err)}`
            : `invalid boolean flag ${name}: ${errorMessage(err)}`,
          { cause: err },
        );
      }
    } else {
      if (!hasValue) {
        const [next] = this.#args;
        if (next === undefined) {
          throw new Error(`flag needs an argument: -${name}`);
        }
        value = next;
        this.#args = this.#args.slice(1);
      }
      try {
        flag.set(value);
      } catch (err) {
        throw new Error(
          `invalid value ${quote(value)} for flag -${name}: ${errorMessage(err)}`,
          { cause: err },
        );
      }
    }
    this.#actual.add(name);
    return true;
  }
}
