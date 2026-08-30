/**
 * The shape of a Cloudflare Email Routing rule, and how this project decides
 * which rules are its own.
 *
 * `deploy.ts` uses this to find an inbox it has already made, and `reset.ts`
 * uses it to decide what to delete. Both run against an account that has other
 * domains, other Workers and other people's mail on it, so the matching is
 * exact and deliberately unclever. No imports, so it can be unit tested.
 */

export interface Zone {
  id: string;
  name: string;
}

export interface EmailRule {
  tag: string;
  name?: string;
  enabled?: boolean;
  matchers?: { type: string; field?: string; value?: string }[];
  actions?: { type: string; value?: string[] }[];
}

/** A rule, on a named domain, that delivers to this Worker. */
export interface RoutedAddress {
  zone: Zone;
  rule: EmailRule;
  address: string;
}

/**
 * Whether this rule delivers to exactly this Worker.
 *
 * Exact, never a prefix or a substring: "popcorn-pager" and
 * "popcorn-pager-test" are two deployments, and resetting one must leave the
 * other's mail alone.
 */
export function targetsWorker(rule: Pick<EmailRule, "actions">, workerName: string): boolean {
  if (!workerName) return false;
  return (rule.actions ?? []).some(action => {
    if (action.type !== "worker") return false;
    // The API returns a list, but a bare string is cheap to survive, and
    // falling back to String.includes here would match by prefix.
    const names = Array.isArray(action.value)
      ? action.value
      : typeof action.value === "string"
        ? [action.value]
        : [];
    return names.includes(workerName);
  });
}

/** The address a rule catches, or nothing for a catch-all. */
export function ruleAddress(rule: Pick<EmailRule, "matchers">): string | undefined {
  return (rule.matchers ?? []).find(matcher => matcher.type === "literal")?.value || undefined;
}

/** The rule `deploy.ts` writes, and the one `reset.ts` expects to find. */
export function ruleBody(address: string, workerName: string) {
  return {
    name: "PopcornPager inbox",
    enabled: true,
    priority: 0,
    matchers: [{ type: "literal", field: "to", value: address }],
    actions: [{ type: "worker", value: [workerName] }],
  };
}
