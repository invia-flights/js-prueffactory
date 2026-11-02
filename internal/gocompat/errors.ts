/**
 * errorMessage is the message of a thrown value: an Error's own message, and
 * the text of anything else that was thrown. Go's err.Error() on the error a
 * call returned.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
