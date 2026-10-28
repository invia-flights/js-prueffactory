export function label(text: string) {
  const count: number = text;
  return <span title={text}>{count}</span>;
}
