import {
  countEnabledRules,
  RESOURCE_TYPES,
  type AppStorage,
  type FilterCondition,
  type HeaderRule,
  type Profile,
  type ResourceType,
} from "./model";

export const DYNAMIC_RULE_ID_START = 1;
export const SESSION_RULE_ID_START = 10_001;
export const MAX_HEADERFORGE_RULES = 4_500;
const PRIORITY_START = 100_000;

export interface CompileResult {
  rules: HeaderForgeDnrRule[];
  usesClockTokens: boolean;
}

function expandDynamicTokens(value: string, now: Date): string {
  return value.replace(
    /\{\{\$(timestamp|isoDate|uuid|randomInt\((-?\d+),\s*(-?\d+)\))\}\}/g,
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

function assertValidHeader(header: HeaderRule): void {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.name)) {
    throw new Error(`Invalid HTTP header name: "${header.name || "(empty)"}"`);
  }
  if (header.operation !== "remove" && /[\r\n]/.test(header.value)) {
    throw new Error(`Header "${header.name}" contains a newline.`);
  }
}

function validateFilter(filter: FilterCondition): void {
  if (!filter.urlPattern.trim()) {
    throw new Error("URL filters cannot be blank.");
  }
  if (filter.isRegex) {
    try {
      new RegExp(filter.urlPattern);
    } catch {
      throw new Error(`Invalid regular expression: ${filter.urlPattern}`);
    }
  }
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

function buildCondition(
  header: HeaderRule,
  filter: FilterCondition | undefined,
  tabIds?: number[],
): HeaderForgeRuleCondition | undefined {
  const resourceTypes = getApplicableResourceTypes(header, filter);
  if (filter && header.resourceTypes.length && filter.resourceTypes.length && !resourceTypes) {
    return undefined;
  }
  const condition: HeaderForgeRuleCondition = {};
  if (filter) {
    validateFilter(filter);
    if (filter.isRegex) {
      condition.regexFilter = filter.urlPattern;
      condition.isUrlFilterCaseSensitive = false;
    } else {
      condition.urlFilter = filter.urlPattern;
      condition.isUrlFilterCaseSensitive = false;
    }
  }
  if (resourceTypes) condition.resourceTypes = resourceTypes;
  if (tabIds?.length) condition.tabIds = tabIds;
  return condition;
}

function getActiveProfiles(config: AppStorage): Profile[] {
  if (!config.masterEnabled) return [];
  const profilesById = new Map(config.profiles.map((profile) => [profile.id, profile]));
  return config.activeProfileIds
    .map((id) => profilesById.get(id))
    .filter((profile): profile is Profile => profile !== undefined && profile.enabled);
}

export function compileDnrRules(
  config: AppStorage,
  options: { tabIds?: number[]; ruleIdStart?: number; now?: Date } = {},
): CompileResult {
  const profiles = getActiveProfiles(config);
  const rules: HeaderForgeDnrRule[] = [];
  const now = options.now ?? new Date();
  let usesClockTokens = false;

  for (const profile of profiles) {
    const filters = profile.filters.length ? profile.filters : [undefined];
    for (const header of profile.headers) {
      if (!header.enabled) continue;
      assertValidHeader(header);
      if (header.operation === "remove" && !header.name) {
        throw new Error("A header name is required before removing a header.");
      }
      const value = header.operation === "remove"
        ? undefined
        : expandDynamicTokens(header.value, now);
      if (/\{\{\$(timestamp|isoDate)\}\}/.test(header.value)) {
        usesClockTokens = true;
      }

      for (const filter of filters) {
        const condition = buildCondition(header, filter, options.tabIds);
        if (!condition) continue;
        const headerInfo: HeaderForgeHeaderInfo = {
          header: header.name,
          operation: header.operation,
        };
        if (value !== undefined) headerInfo.value = value;
        const id = (options.ruleIdStart ?? DYNAMIC_RULE_ID_START) + rules.length;
        rules.push({
          id,
          priority: Math.max(1, PRIORITY_START - rules.length),
          action: {
            type: "modifyHeaders",
            ...(header.type === "request"
              ? { requestHeaders: [headerInfo] }
              : { responseHeaders: [headerInfo] }),
          },
          condition,
        });
        if (rules.length > MAX_HEADERFORGE_RULES) {
          throw new Error(
            `This configuration expands to more than ${MAX_HEADERFORGE_RULES.toLocaleString()} browser rules. Reduce the number of active rules or URL filters.`,
          );
        }
      }
    }
  }

  return { rules, usesClockTokens };
}

export function matchesUrlPattern(pattern: string, url: string, isRegex: boolean): boolean {
  try {
    if (isRegex) return new RegExp(pattern, "i").test(url);
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i").test(url);
  } catch {
    return false;
  }
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
        total +
        profile.headers.filter((header) => header.enabled).length
      );
    }, 0);
}

export function activeHeaderCount(config: AppStorage): number {
  return countEnabledRules(config);
}
