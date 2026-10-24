export function stamp(date: Date): string {
  const compact = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${compact.slice(0, 8)}-${compact.slice(8)}`;
}
