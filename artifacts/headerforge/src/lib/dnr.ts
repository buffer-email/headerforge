import {
  countEnabledRules,
  RESOURCE_TYPES,
  type AppStorage,
  type FilterCondition,
  type HeaderOperation,
  type HeaderRule,
  type Profile,
  type ResourceType,
  type RuleType,
} from "./model";
import {
  MAX_TEST_URL_LENGTH,
  isForbiddenHeader,
  validateHeaderField,
  validateUrlPattern,
} from "./limits";

export const DYNAMIC_RULE_ID_START = 1;
export const SESSION_RULE_ID_START = 10_001;
export const MAX_HEADERFORGE_RULES = 4_500;
const PRIORITY_START = 100_000;
/** Spacing kept between the dynamic and session id ranges so they never overlap. */
const RULE_ID_STRIDE = MAX_HEADERFORGE_RULES + 1;

export interface CompileResult {
  rules: HeaderForgeDnrRule[];
  usesClockTokens: boolean;
  /** Rules that were skipped, with the reason. Never throws for these. */
  problems: string[];
}

/**
 * Bounded cache for compiled matchers.
 *
 * The live URL tester and the enabled-rule counter both re-run pattern matching
 * on every keystroke. Compiling a fresh RegExp per call is what makes a profile
 * with a few hundred filters feel sluggish, so we memoise with an LRU bound.
 */
const MATCHER_CACHE_LIMIT = 512;
const matcherCache = new Map<string, RegExp | null>();

function cachedRegex(key: string, build: () => RegExp): RegExp | null {
  const hit = matcherCache.get(key);
  if (hit !== undefined) {
    // Refresh recency for the LRU.
    matcherCache.delete(key);
    matcherCache.set(key, hit);
    return hit;
  }
  let compiled: RegExp | null;
  try {
    compiled = build();
  } catch {
    compiled = null;
  }
  if (matcherCache.size >= MATCHER_CACHE_LIMIT) {
    const oldest = matcherCache.keys().next().value;
    if (oldest !== undefined) matcherCache.delete(oldest);
  }
  matcherCache.set(key, compiled);
  return compiled;
}

export function clearMatcherCache(): void {
  matcherCache.clear();
}

const TOKEN_PATTERN =
  /\{\{\s*\$(timestamp|isoDate|uuid|randomInt\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\))\s*\}\}/g;

export function usesClockTokens(value: string): boolean {
  return /\{\{\s*\$(timestamp|isoDate)\s*\}\}/.test(value);
}

function expandDynamicTokens(value: string, now: Date): string {
  TOKEN_PATTERN.lastIndex = 0;
  return value.replace(
    TOKEN_PATTERN,
    (token, kind: string, minText?: string, maxText?: string) => {
      if (kind === "timestamp") return String(Math.floor(now.getTime() / 1000));
      if (kind === "isoDate") return now.toISOString();
      if (kind === "uuid") return crypto.randomUUID();
      if (kind.startsWith("randomInt(")) {
        const min = Number(minText);
        const max = Number(maxText);
        if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
          throw new Error(`Invalid random integer token: ${token}`);
        }
        return String(Math.floor(Math.random() * (max - min + 1)) + min);
      }
      return token;
    },
  );
}

function getApplicableResourceTypes(
  header: HeaderRule,
  filter?: FilterCondition,
): ResourceType[] | undefined {
  const headerTypes = header.resourceTypes.filter((type) =>
    RESOURCE_TYPES.includes(type),
  );
  const filterTypes =
    filter?.resourceTypes.filter((type) => RESOURCE_TYPES.includes(type)) ?? [];

  if (headerTypes.length && filterTypes.length) {
    const intersection = headerTypes.filter((type) => filterTypes.includes(type));
    return intersection.length ? intersection : undefined;
  }
  if (filterTypes.length) return filterTypes;
  if (headerTypes.length) return headerTypes;
  return undefined;
}

interface CompiledCondition {
  condition: HeaderForgeRuleCondition;
  /** Stable key so rules that compile to the same matcher can be reused. */
  key: string;
}

function buildCondition(
  header: HeaderRule,
  filter: FilterCondition | undefined,
  tabIds: number[] | undefined,
): CompiledCondition | undefined {
  const resourceTypes = getApplicableResourceTypes(header, filter);
  // Header and filter restrict resource types to disjoint sets: no overlap.
  if (
    filter &&
    header.resourceTypes.length &&
    filter.resourceTypes.length &&
    !resourceTypes
  ) {
    return undefined;
  }
  const condition: HeaderForgeRuleCondition = {};
  let key = "";
  if (filter) {
    if (filter.isRegex) {
      condition.regexFilter = filter.urlPattern;
      key = `r:${filter.urlPattern}`;
    } else {
      condition.urlFilter = filter.urlPattern;
      key = `g:${filter.urlPattern}`;
    }
    condition.isUrlFilterCaseSensitive = false;
  }
  if (resourceTypes) {
    condition.resourceTypes = resourceTypes;
    key += `|t:${resourceTypes.join(",")}`;
  }
  if (tabIds?.length) {
    condition.tabIds = tabIds;
    key += `|tab:${tabIds.join(",")}`;
  }
  return { condition, key };
}

function getActiveProfiles(config: AppStorage): Profile[] {
  if (!config.masterEnabled) return [];
  const profilesById = new Map(config.profiles.map((profile) => [profile.id, profile]));
  return config.activeProfileIds
    .map((id) => profilesById.get(id))
    .filter((profile): profile is Profile => profile !== undefined && profile.enabled);
}

/**
 * Bucket key for rule grouping. Headers sharing a bucket can be merged into one
 * DNR action; mixing operations would be rejected by some Chromium versions, so
 * direction and operation are part of the key.
 */
function bucketKey(
  conditionKey: string,
  type: RuleType,
  operation: HeaderOperation,
): string {
  return `${conditionKey}|${type}|${operation}`;
}

/**
 * Compiles the active configuration into declarativeNetRequest rules.
 *
 * Scalability note: rules are *grouped*, not emitted one-per-header. A profile
 * with 200 headers behind one URL filter collapses into at most three DNR rules
 * (set / append / remove, per direction) instead of 200. That keeps the rule
 * set small enough for Chromium to evaluate in microseconds and keeps the
 * updateDynamicRules IPC payload orders of magnitude smaller.
 */
export function compileDnrRules(
  config: AppStorage,
  options: { tabIds?: number[]; ruleIdStart?: number; now?: Date } = {},
): CompileResult {
  const profiles = getActiveProfiles(config);
  const now = options.now ?? new Date();
  const ruleIdStart = options.ruleIdStart ?? DYNAMIC_RULE_ID_START;
  const problems: string[] = [];
  let needsClockRefresh = false;

  const buckets = new Map<
    string,
    { condition: HeaderForgeRuleCondition; direction: RuleType; headers: HeaderForgeHeaderInfo[] }
  >();
  const order: string[] = [];

  for (const profile of profiles) {
    // Validate filters once per profile rather than once per header: a single
    // malformed filter used to abort the loop, silently disabling every rule in
    // the profile, and duplicated its warning once per header.
    const usableFilters: Array<FilterCondition | undefined> = [];
    for (const filter of profile.filters.length ? profile.filters : [undefined]) {
      if (!filter) {
        usableFilters.push(undefined);
        continue;
      }
      const filterProblem = validateUrlPattern(filter.urlPattern, filter.isRegex);
      if (filterProblem) {
        problems.push(
          `${profile.id}::${filter.urlPattern}: ${filterProblem.message} Rules matching only this filter were skipped.`,
        );
        continue;
      }
      usableFilters.push(filter);
    }

    const filters = usableFilters;
    const scope = `${profile.id}::`;
    for (const header of profile.headers) {
      if (!header.enabled) continue;
      const label = `${scope}${header.name || "(unnamed header)"}`;

      const fieldProblem = validateHeaderField(header.name, header.value, header.operation);
      if (fieldProblem) {
        problems.push(`${label}: ${fieldProblem.message}`);
        continue;
      }
      // Removal is intentionally allowed for headers Chromium forbids modifying
      // (e.g. stripping a request Cookie), so the check applies to set/append only.
      if (header.operation !== "remove" && isForbiddenHeader(header.name, header.type)) {
        problems.push(
          `${label}: Chromium does not allow extensions to modify this ${header.type} header.`,
        );
        continue;
      }
      if (usesClockTokens(header.value)) needsClockRefresh = true;

      let value: string | undefined;
      if (header.operation !== "remove") {
        try {
          value = expandDynamicTokens(header.value, now);
        } catch (error) {
          problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
      }

      const headerInfo: HeaderForgeHeaderInfo = {
        header: header.name,
        operation: header.operation,
      };
      if (value !== undefined) headerInfo.value = value;

      for (const filter of filters) {
        const compiled = buildCondition(header, filter, options.tabIds);
        if (!compiled) continue;

        const key = bucketKey(compiled.key, header.type, header.operation);
        const existing = buckets.get(key);
        if (existing) {
          // Chromium rejects duplicate header names inside a single action.
          if (existing.headers.some((entry) => entry.header === header.name)) {
            problems.push(
              `${label}: duplicates an earlier rule with the same match and operation; only the first is applied.`,
            );
            continue;
          }
          existing.headers.push(headerInfo);
          continue;
        }
        buckets.set(key, {
          condition: compiled.condition,
          direction: header.type,
          headers: [headerInfo],
        });
        order.push(key);

        if (buckets.size > MAX_HEADERFORGE_RULES) {
          throw new Error(
            `This configuration expands to more than ${MAX_HEADERFORGE_RULES.toLocaleString()} browser rules. Reduce the number of active profiles, rules, or URL filters.`,
          );
        }
      }
    }
  }

  const rules: HeaderForgeDnrRule[] = order.map((key, index) => {
    const bucket = buckets.get(key)!;
    return {
      id: ruleIdStart + index,
      priority: Math.max(1, PRIORITY_START - index),
      action: {
        type: "modifyHeaders",
        ...(bucket.direction === "response"
          ? { responseHeaders: bucket.headers }
          : { requestHeaders: bucket.headers }),
      },
      condition: bucket.condition,
    };
  });

  return { rules, usesClockTokens: needsClockRefresh, problems };
}

export function matchesUrlPattern(pattern: string, url: string, isRegex: boolean): boolean {
  if (!pattern || !url || url.length > MAX_TEST_URL_LENGTH) return false;
  if (findControlChars(url) !== undefined) return false;
  const key = isRegex ? `r:${pattern}` : `g:${pattern}`;
  const matcher = cachedRegex(key, () =>
    isRegex
      ? new RegExp(pattern, "i")
      : new RegExp(
          `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*")}$`,
          "i",
        ),
  );
  return matcher ? matcher.test(url) : false;
}

function findControlChars(value: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001F\u007F]/.exec(value)?.[0];
}

export function getMatchedRuleCount(config: AppStorage, url: string): number {
  if (!config.masterEnabled) return 0;
  const activeIds = new Set(config.activeProfileIds);
  return config.profiles
    .filter((profile) => profile.enabled && activeIds.has(profile.id))
    .reduce((total, profile) => {
      const matchingFilters =
        profile.filters.length === 0 ||
        profile.filters.some((filter) =>
          matchesUrlPattern(filter.urlPattern, url, filter.isRegex),
        );
      if (!matchingFilters) return total;
      return (
        total + profile.headers.filter((header) => header.enabled).length
      );
    }, 0);
}

export function activeHeaderCount(config: AppStorage): number {
  return countEnabledRules(config);
}

/**
 * Counts how many DNR rules the current configuration would produce.
 * Surfaced in the UI so users can see the cost of a profile before saving it.
 */
export function estimateRuleCount(config: AppStorage): number {
  try {
    return compileDnrRules(config).rules.length;
  } catch {
    return MAX_HEADERFORGE_RULES;
  }
}

export { RULE_ID_STRIDE };