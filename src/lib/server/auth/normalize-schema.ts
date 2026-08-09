export function normalizeGeneratedAuthSchema(source: string): string {
  return source.replace(
    /timestamp\(("[^"]+")\)(?!, \{ withTimezone: true \})/g,
    'timestamp($1, { withTimezone: true })'
  );
}
