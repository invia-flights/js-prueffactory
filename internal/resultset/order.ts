import { marshal, type Shape } from "../gocompat/json.ts";
import { compareBytes } from "../gocompat/strings.ts";
import type { Set } from "./types.ts";
import { ServiceShape } from "./types.ts";

/**
 * canonical is the JSON of a value as Go's json.Marshal writes it (compact,
 * HTML escaped, fields in declaration order), used as the last tie-breaker of
 * a sort. The ID of a Finding or test case is left out because it is the
 * temporary key the sort replaces.
 */
export function canonical(v: object, shape: Shape, withoutID = false): string {
  return marshal(withoutID ? { ...v, id: "" } : v, shape, { escapeHTML: true });
}

/** derefString is "" for null, as Go code read a nil *string. */
export function derefString(p: string | null): string {
  return p ?? "";
}

/**
 * sortLists puts the lists no ID refers to into a fixed order: Contexts,
 * Limitations, Services and the Inventory.
 */
export function sortLists(s: Set): void {
  s.contexts.sort((a, b) => compareBytes(a.id, b.id));
  s.limitations.sort(
    (a, b) =>
      compareBytes(derefString(a.check_id), derefString(b.check_id)) ||
      compareBytes(a.reason_code, b.reason_code) ||
      compareBytes(derefString(a.path), derefString(b.path)) ||
      compareBytes(a.message, b.message),
  );
  s.services.sort(
    (a, b) =>
      compareBytes(a.family, b.family) ||
      compareBytes(a.compose_service, b.compose_service) ||
      compareBytes(canonical(a, ServiceShape), canonical(b, ServiceShape)),
  );
  const inv = s.inventory;
  inv.tests.sort((a, b) => compareBytes(a.context_id, b.context_id));
  // Suites keep the order they run in, which the Check put them in.
  inv.test_suites.sort((a, b) => compareBytes(a.context_id, b.context_id));
  inv.test_files.sort(
    (a, b) =>
      compareBytes(a.context_id, b.context_id) ||
      compareBytes(a.suite, b.suite) ||
      compareBytes(a.file, b.file),
  );
  inv.suppressions.sort(
    (a, b) =>
      compareBytes(a.kind, b.kind) || compareBytes(a.file_class, b.file_class),
  );
  inv.file_hashes.sort(
    (a, b) => compareBytes(a.path, b.path) || compareBytes(a.role, b.role),
  );
  inv.moved_test_files.sort(
    (a, b) =>
      compareBytes(a.context_id, b.context_id) ||
      compareBytes(a.path, b.path) ||
      compareBytes(a.suite, b.suite),
  );
  inv.size.sort(
    (a, b) => compareBytes(a.group, b.group) || compareBytes(a.name, b.name),
  );
}
