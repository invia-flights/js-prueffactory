// Cache volumes outlive a Run. They carry cache labels and never a run label,
// so removeRunResources keeps them. Their names and labels are the Go build's,
// so a Run of either build reuses what the other downloaded.
import { quote } from "../gocompat/fmt.ts";
import {
  byteOrder,
  fields,
  lastLine,
  trimSpace,
  volumeName,
} from "./common.ts";
import type { Driver } from "./driver.ts";

// Label keys of cache volumes.
export const LabelCache = "js-prueffactory.cache";
export const LabelToolsetVersion = "js-prueffactory.toolset-version";

const cacheKind = /^[a-z0-9][a-z0-9-]*$/;

// createCacheVolume creates a volume with the given labels, or does nothing
// when it exists. The volume does not belong to the Run.
export async function createCacheVolume(
  d: Driver,
  signal: AbortSignal,
  name: string,
  labels: Readonly<Record<string, string>>,
): Promise<void> {
  if (!volumeName.test(name)) {
    throw new Error(
      `refusing to create volume ${quote(name)}: not a js-prueffactory name`,
    );
  }
  const args = ["volume", "create"];
  for (const k of Object.keys(labels).sort(byteOrder)) {
    args.push("--label", k + "=" + (labels[k] ?? ""));
  }
  args.push(name);
  await d.output(signal, args);
}

// cacheVolume makes sure the cache volume of a kind, such as "npm", exists and
// returns its name, jspf-cache-<kind>. The volume carries the cache label with
// the kind as its value and survives between Runs. Creating a volume that
// exists is harmless, so concurrent Runs may call it at the same time.
export async function cacheVolume(
  d: Driver,
  signal: AbortSignal,
  kind: string,
): Promise<string> {
  if (!cacheKind.test(kind)) {
    throw new Error(`${quote(kind)} is not a valid cache kind`);
  }
  const name = "jspf-cache-" + kind;
  await createCacheVolume(d, signal, name, { [LabelCache]: kind });
  return name;
}

// listVolumes returns the names of the volumes that match a `docker volume ls`
// filter such as "label=js-prueffactory.cache=toolset".
export async function listVolumes(
  d: Driver,
  signal: AbortSignal,
  filter: string,
): Promise<string[]> {
  const out = await d.output(signal, [
    "volume",
    "ls",
    "--quiet",
    "--filter",
    filter,
  ]);
  return fields(out.toString());
}

// volumeLabel returns the value of one label of a volume, or "".
export async function volumeLabel(
  d: Driver,
  signal: AbortSignal,
  name: string,
  key: string,
): Promise<string> {
  const out = await d.output(signal, [
    "volume",
    "inspect",
    "--format",
    `{{index .Labels "${key}"}}`,
    name,
  ]);
  return trimSpace(out.toString());
}

// removeVolumeIfUnused removes a volume unless a container still uses it, a
// stopped or never-started one included. It reports whether it was removed. A
// volume that is already gone counts as removed.
export async function removeVolumeIfUnused(
  d: Driver,
  signal: AbortSignal,
  name: string,
): Promise<boolean> {
  const errb: Buffer[] = [];
  const code = await d.run(signal, ["volume", "rm", name], {
    stderr: (p) => errb.push(p),
  });
  if (code === 0) {
    return true;
  }
  const msg = Buffer.concat(errb).toString();
  if (msg.includes("in use")) {
    return false;
  }
  if (msg.includes("No such volume")) {
    return true;
  }
  throw new Error(
    `docker volume rm ${name} failed (exit ${String(code)}): ${lastLine(msg)}`,
  );
}

// hold creates, without starting it, a run-owned container that mounts a
// volume read-only. Docker treats the volume as in use until the Run's cleanup
// removes the container, so no other Run can delete it in the meantime.
export async function hold(
  d: Driver,
  signal: AbortSignal,
  suffix: string,
  image: string,
  volume: string,
  mountPath: string,
): Promise<void> {
  if (!volumeName.test(volume)) {
    throw new Error(
      `refusing to hold ${quote(volume)}: not a js-prueffactory volume`,
    );
  }
  const args = ["create", "--name", d.name(suffix), "--pull", "never"];
  args.push(
    ...d.labels(),
    "--volume",
    volume + ":" + mountPath + ":ro",
    image,
    "true",
  );
  await d.output(signal, args);
}
