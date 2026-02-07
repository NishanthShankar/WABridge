const VARIABLE_REGEX = /\{\{(\w+)\}\}/g;

/**
 * Extract all unique variable names from a template body.
 *
 * Example:
 * "Hello {{name}}, your bill of {{amount}} is due {{date}}"
 * -> ["name", "amount", "date"]
 */
export function extractVariables(body: string): string[] {
  const matches = body.matchAll(VARIABLE_REGEX);
  const variables = new Set<string>();
  for (const match of matches) {
    variables.add(match[1]);
  }
  return [...variables];
}

/**
 * Resolve template variables against a data object.
 * Unresolved variables are left as-is (e.g., {{unknown}} stays as {{unknown}}).
 */
export function resolveTemplate(
  body: string,
  data: Record<string, string>,
): string {
  return body.replace(VARIABLE_REGEX, (match, key) => {
    return key in data ? data[key] : match;
  });
}
