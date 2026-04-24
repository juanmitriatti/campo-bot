/**
 * Simple template interpolation for configurable bot messages.
 * Replaces {{varName}} with values from the vars object.
 */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

/**
 * Split a newline-separated pool string into an array of non-empty strings.
 * Used for confirmation message pools stored as a single setting value.
 */
export function splitPool(setting: string): string[] {
  return setting.split('\n').map(s => s.trim()).filter(Boolean);
}
