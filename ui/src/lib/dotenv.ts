// dotenv.ts — parse/serialize .env-style text for the deployments env editor.
//
// Same validation rules as the backend (backend/src/routes/deployments.js):
// keys match /^[A-Za-z_][A-Za-z0-9_]*$/, values are strings, at most 100 vars
// per service. Comments (#) and blank lines are cosmetic and not stored.

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_ENV_VARS = 100;

export interface DotenvParseResult {
  vars: Record<string, string>;
  errors: string[]; // human-readable, with line numbers
}

// Parse a .env-style document. Accepted lines:
//   KEY=value            (value may contain '='; split on the first one)
//   export KEY=value     (optional prefix, stripped)
//   KEY="value" / KEY='value'   (surrounding quotes stripped)
//   # comment / blank    (skipped — they are not persisted)
export function parseDotenv(text: string): DotenvParseResult {
  const vars: Record<string, string> = {};
  const errors: string[] = [];
  const dupes = new Set<string>();

  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    const no = idx + 1;
    if (!line || line.startsWith('#')) return;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) {
      errors.push(`Line ${no}: expected KEY=value (or blank/# comment)`);
      return;
    }
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (!ENV_KEY_RE.test(key)) {
      errors.push(`Line ${no}: invalid name '${key}' — use [A-Za-z_][A-Za-z0-9_]*`);
      return;
    }
    if (key in vars) {
      errors.push(`Line ${no}: duplicate name '${key}'`);
      return;
    }
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  });

  if (Object.keys(vars).length > MAX_ENV_VARS) {
    errors.push(`At most ${MAX_ENV_VARS} variables per service (found ${Object.keys(vars).length})`);
  }
  return { vars, errors };
}

// Serialize a vars map back to .env text (sorted keys, quoted when needed).
export function serializeDotenv(vars: Record<string, string>): string {
  return Object.keys(vars)
    .sort()
    .map(k => {
      const v = vars[k];
      // Quote when the value has surrounding whitespace, newlines, or would
      // otherwise be ambiguous.
      const needsQuotes = v === '' ? false : /[\s]/.test(v) || v.startsWith('#') || v.includes('"');
      return `${k}=${needsQuotes ? `"${v.replace(/"/g, '\\"')}"` : v}`;
    })
    .join('\n');
}
