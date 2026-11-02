// EndMarker lets a container tell the driver that its work is finished, so the
// driver can stop it when the process then fails to exit. The container prints
// text on stdout or stderr when it is done. From that moment the process has
// graceMs milliseconds to exit on its own; after that the driver stops the
// container and the result says so (ContainerResult.stoppedAfterGrace). text
// should hold a value that only the caller and the container know, such as a
// random token, and the marker lines are removed from the captured output.
export interface EndMarker {
  readonly text: string;
  readonly graceMs: number;
}

// MarkerWriter passes everything on to dst and calls onSeen once when the
// marker has passed through, even when it arrives in several writes.
export class MarkerWriter {
  readonly #dst: (p: Buffer) => void;
  readonly #marker: Buffer;
  readonly #onSeen: () => void;
  #tail: Buffer = Buffer.alloc(0); // the last marker.length-1 bytes written
  #done = false;

  constructor(dst: (p: Buffer) => void, marker: Buffer, onSeen: () => void) {
    this.#dst = dst;
    this.#marker = marker;
    this.#onSeen = onSeen;
  }

  write(p: Buffer): void {
    if (!this.#done && this.#marker.length > 0) {
      const window = Buffer.concat([this.#tail, p]);
      const keep = this.#marker.length - 1;
      if (window.includes(this.#marker)) {
        this.#done = true;
        this.#tail = Buffer.alloc(0);
        this.#onSeen();
      } else if (window.length > keep) {
        this.#tail = window.subarray(window.length - keep);
      } else {
        this.#tail = window;
      }
    }
    this.#dst(p);
  }
}

function replaceAll(out: Buffer, old: Buffer): Buffer {
  const parts: Buffer[] = [];
  let from = 0;
  for (let i = out.indexOf(old, from); i >= 0; i = out.indexOf(old, from)) {
    parts.push(out.subarray(from, i));
    from = i + old.length;
  }
  parts.push(out.subarray(from));
  return Buffer.concat(parts);
}

// stripMarker removes the marker and the line break after it from captured
// output.
export function stripMarker(out: Buffer, marker: Buffer): Buffer {
  if (marker.length === 0) {
    return out;
  }
  const withBreak = Buffer.concat([marker, Buffer.from("\n")]);
  return replaceAll(replaceAll(out, withBreak), marker);
}

// GraceStop stops a container once the grace period after its end marker has
// passed.
export class GraceStop {
  readonly #graceMs: number;
  readonly #stop: () => Promise<void>;
  #timer: NodeJS.Timeout | undefined;
  #stopping: Promise<void> | undefined;
  #stopped = false;

  constructor(graceMs: number, stop: () => Promise<void>) {
    this.#graceMs = graceMs;
    this.#stop = stop;
  }

  // seen starts the grace period, the first time it is called.
  seen(): void {
    if (this.#timer !== undefined) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#stopped = true;
      this.#stopping = this.#stop();
    }, this.#graceMs);
  }

  // cancel ends the grace period, for a container that finished by itself.
  // It waits for a stop that is already under way.
  async cancel(): Promise<void> {
    clearTimeout(this.#timer);
    await this.#stopping;
  }

  get didStop(): boolean {
    return this.#stopped;
  }
}
