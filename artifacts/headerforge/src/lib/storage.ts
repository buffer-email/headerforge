import {
  cloneConfig,
  CURRENT_VERSION,
  DEFAULT_CONFIG,
  isColorTag,
  isDensity,
  RESOURCE_TYPES,
  STORAGE_KEY,
  type AppStorage,
  type ColorTag,
  type Density,
  type FilterCondition,
  type HeaderOperation,
  type HeaderRule,
  type Profile,
  type ResourceType,
  type RuleType,
  type TabScope,
  type ThemeSetting,
} from "./model";
import {
  MAX_FILTERS_PER_PROFILE,
  MAX_HEADERS_PER_PROFILE,
  MAX_ID_LENGTH,
  MAX_PROFILES,
  MAX_PROFILE_NAME_LENGTH,
  MAX_URL_PATTERN_LENGTH,
  truncate,
  validateHeaderField,
  validateUrlPattern,
} from "./limits";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Number of rules silently repaired while normalising a configuration. */
export interface NormalizeReport {
  warnings: string[];
}

export interface ValidateOptions {
  /** Receives human-readable notes about rules that were dropped or repaired. */
  report?: NormalizeReport;
}

const HEADER_OPERATIONS: readonly HeaderOperation[] = ["set", "append", "remove"];
const RULE_TYPES: readonly RuleType[] = ["request", "response"];

function note(report: NormalizeReport | undefined, message: string): void {
  report?.warnings.push(message);
}

function sanitizeId(value: unknown, fallbackPrefix: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return undefined;
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : undefined;
}

/**
 * Reads an `enabled` flag without ever enabling something by accident.
 *
 * Accepts real booleans and the strings "true"/"false" (trimmed, any case), which is
 * what legacy and hand-edited exports actually contain. `whenAbsent` covers the one
 * case that is genuinely a choice rather than a guess: a field that is not there at
 * all. That follows the format default (legacy formats have no `enabled` key and
 * everything in them is on, so callers pass `true`).
 *
 * A field that *is* present but unreadable never falls back to `whenAbsent`; it
 * fails closed to `false`, so a typo can never silently activate a rule.
 *
 * This is deliberately *not* the `coerceBoolean` helper in import-utils.ts, which
 * falls back to its argument for any unrecognised input. Never route an `enabled`
 * field through that one: an unrecognised value would resolve to `true` and switch
 * traffic rewriting on.
 */
export function coerceEnabledFlag(
  value: unknown,
  whenAbsent = false,
): { value: boolean; coerced: boolean } {
  if (typeof value === "boolean") return { value, coerced: false };
  if (value === undefined || value === null) return { value: whenAbsent, coerced: true };
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return { value: true, coerced: true };
    if (normalized === "false") return { value: false, coerced: true };
  }
  return { value: false, coerced: true };
}

function sanitizeResourceTypes(value: unknown): ResourceType[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<ResourceType>();
  for (const entry of value) {
    if (typeof entry === "string" && RESOURCE_TYPES.includes(entry as ResourceType)) {
      seen.add(entry as ResourceType);
    }
  }
  return RESOURCE_TYPES.filter((type) => seen.has(type));
}

function normalizeHeader(
  raw: Record<string, unknown>,
  fallbackId: string,
  report?: NormalizeReport,
): { rule: HeaderRule } | { error: string } {
  if (typeof raw.name !== "string") return { error: "header name must be a string" };
  if (typeof raw.value !== "string") return { error: "header value must be a string" };
  if (!RULE_TYPES.includes(raw.type as RuleType)) return { error: "unknown header direction" };
  if (!HEADER_OPERATIONS.includes(raw.operation as HeaderOperation)) {
    return { error: "unknown header operation" };
  }
  const operation = raw.operation as HeaderOperation;
  const name = raw.name.trim();
  const value = operation === "remove" ? "" : raw.value;
  const problem = validateHeaderField(name, value, operation);
  if (problem) return { error: problem.message };
  const enabled = coerceEnabledFlag(raw.enabled);
  if (typeof raw.enabled !== "boolean" && typeof raw.enabled !== "string") {
    note(
      report,
      `Header "${name}" had a non-boolean enabled value; it was left disabled.`,
    );
  }
  return {
    rule: {
      id: fallbackId,
      enabled: enabled.value,
      type: raw.type as RuleType,
      operation,
      name,
      value,
      resourceTypes: sanitizeResourceTypes(raw.resourceTypes),
    },
  };
}

function normalizeFilter(
  raw: Record<string, unknown>,
  fallbackId: string,
): { filter: FilterCondition } | { error: string } {
  if (typeof raw.urlPattern !== "string") return { error: "URL pattern must be a string" };
  const urlPattern = raw.urlPattern.trim();
  const isRegex = raw.isRegex === true;
  const problem = validateUrlPattern(urlPattern, isRegex);
  if (problem) return { error: problem.message };
  if (urlPattern.length > MAX_URL_PATTERN_LENGTH) return { error: "URL pattern too long" };
  return {
    filter: {
      id: fallbackId,
      urlPattern,
      isRegex,
      resourceTypes: sanitizeResourceTypes(raw.resourceTypes),
    },
  };
}

/**
 * Normalises an arbitrary value into a usable configuration.
 *
 * Structural problems (no `profiles` array, missing `masterEnabled`) throw,
 * because there is nothing sensible to fall back to. Problems confined to a
 * single rule are dropped with a warning instead: one malformed header should
 * never cost the user every other rule they configured.
 */
export function validateConfig(input: unknown, options: ValidateOptions = {}): AppStorage {
  const report = options.report;
  if (!isRecord(input) || !Array.isArray(input.profiles)) {
    throw new Error("This file is not a valid HeaderForge configuration.");
  }
  if (typeof input.masterEnabled !== "boolean") {
    throw new Error("Configuration is missing the global enablement setting.");
  }
  if (input.profiles.length > MAX_PROFILES) {
    throw new Error(
      `Configuration declares ${input.profiles.length.toLocaleString()} profiles; the limit is ${MAX_PROFILES.toLocaleString()}.`,
    );
  }

  const profileIds = new Set<string>();
  const globalRuleIds = new Set<string>();
  const profiles: Profile[] = [];
  let droppedHeaders = 0;
  let droppedFilters = 0;

  const rawProfiles = input.profiles as unknown[];
  for (let index = 0; index < rawProfiles.length; index += 1) {
    const raw = rawProfiles[index];
    if (!isRecord(raw)) {
      note(report, `Profile ${index + 1} is not an object and was skipped.`);
      continue;
    }
    if (!Array.isArray(raw.headers) || !Array.isArray(raw.filters)) {
      note(report, `Profile ${index + 1} has invalid rules or filters and was skipped.`);
      continue;
    }
    if (profileIds.size >= MAX_PROFILES) break;

    const rawName = typeof raw.name === "string" ? raw.name.trim() : "";
    const baseId = sanitizeId(raw.id, `profile-${index + 1}`);
    let profileId = baseId;
    if (profileId && profileIds.has(profileId)) {
      profileId = undefined;
      note(report, `Profile ${index + 1} had a duplicate ID; a new one was assigned.`);
    }
    if (!profileId) profileId = `profile-restored-${crypto.randomUUID()}`;
    profileIds.add(profileId);

    if (raw.headers.length > MAX_HEADERS_PER_PROFILE) {
      note(
        report,
        `Profile "${rawName || profileId}" had ${raw.headers.length.toLocaleString()} headers; only the first ${MAX_HEADERS_PER_PROFILE.toLocaleString()} were kept.`,
      );
    }

    const headers: HeaderRule[] = [];
    const seenHeaderIds = new Set<string>();
    for (let h = 0; h < Math.min(raw.headers.length, MAX_HEADERS_PER_PROFILE); h += 1) {
      const rawHeader = raw.headers[h];
      if (!isRecord(rawHeader)) {
        droppedHeaders += 1;
        continue;
      }
      const suppliedId = sanitizeId(rawHeader.id, "");
      let id = suppliedId;
      if (id && (seenHeaderIds.has(id) || globalRuleIds.has(id))) {
        note(report, `A header in "${rawName || profileId}" had a duplicate ID; a new one was assigned.`);
        id = "";
      }
      const parsed = normalizeHeader(rawHeader, id || `header-${crypto.randomUUID()}`, report);
      if ("error" in parsed) {
        const label = typeof rawHeader.name === "string" && rawHeader.name.trim()
          ? rawHeader.name.trim()
          : `header ${h + 1}`;
        note(report, `Dropped "${truncate(label, 40)}": ${parsed.error}.`);
        droppedHeaders += 1;
        continue;
      }
      seenHeaderIds.add(parsed.rule.id);
      globalRuleIds.add(parsed.rule.id);
      headers.push(parsed.rule);
    }

    if (raw.filters.length > MAX_FILTERS_PER_PROFILE) {
      note(
        report,
        `Profile "${rawName || profileId}" had ${raw.filters.length.toLocaleString()} URL filters; only the first ${MAX_FILTERS_PER_PROFILE.toLocaleString()} were kept.`,
      );
    }

    const filters: FilterCondition[] = [];
    const seenFilterIds = new Set<string>();
    for (let f = 0; f < Math.min(raw.filters.length, MAX_FILTERS_PER_PROFILE); f += 1) {
      const rawFilter = raw.filters[f];
      if (!isRecord(rawFilter)) {
        droppedFilters += 1;
        continue;
      }
      const suppliedId = sanitizeId(rawFilter.id, "");
      let id = suppliedId;
      if (id && (seenFilterIds.has(id) || globalRuleIds.has(id))) {
        note(report, `A URL filter in "${rawName || profileId}" had a duplicate ID; a new one was assigned.`);
        id = "";
      }
      const parsed = normalizeFilter(rawFilter, id || `filter-${crypto.randomUUID()}`);
      if ("error" in parsed) {
        const label = typeof rawFilter.urlPattern === "string" && rawFilter.urlPattern.trim()
          ? rawFilter.urlPattern.trim()
          : `filter ${f + 1}`;
        note(report, `Dropped URL filter "${truncate(label, 48)}": ${parsed.error}.`);
        droppedFilters += 1;
        continue;
      }
      seenFilterIds.add(parsed.filter.id);
      globalRuleIds.add(parsed.filter.id);
      filters.push(parsed.filter);
    }

    if (droppedHeaders || droppedFilters) {
      note(
        report,
        `"${rawName || profileId}" kept ${headers.length} header(s) and ${filters.length} filter(s) after validation.`,
      );
    }

    const profileEnabled = coerceEnabledFlag(raw.enabled);
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
      note(
        report,
        `Profile "${rawName || profileId}" had a non-boolean enabled value; it was left ${
          profileEnabled.value ? "enabled" : "disabled"
        }.`,
      );
    }

    profiles.push({
      id: profileId,
      name: rawName ? truncate(rawName, MAX_PROFILE_NAME_LENGTH) : "Imported profile",
      colorTag: isColorTag(raw.colorTag) ? (raw.colorTag as ColorTag) : "blue",
      enabled: profileEnabled.value,
      headers,
      filters,
    });
  }

  if (droppedHeaders || droppedFilters) {
    note(
      report,
      `${droppedHeaders} header rule(s) and ${droppedFilters} URL filter(s) were rejected as invalid.`,
    );
  }

  const requestedActive = new Set(
    (Array.isArray(input.activeProfileIds) ? input.activeProfileIds : []).filter(
      (id): id is string => typeof id === "string" && profileIds.has(id),
    ),
  );
  // Order follows `profiles`, not the input array, because declarativeNetRequest
  // rule priority is derived from this sequence. Keeps it consistent with the
  // UI and with applyImportedConfig.
  const activeProfileIds = profiles
    .filter((profile) => requestedActive.has(profile.id))
    .map((profile) => profile.id);

  const settings = isRecord(input.settings) ? input.settings : {};
  const theme: ThemeSetting =
    settings.theme === "dark" || settings.theme === "light" ? settings.theme : "system";
  const tabScopeDefault: TabScope = settings.tabScopeDefault === "tab" ? "tab" : "global";
  const density: Density = isDensity(settings.density) ? settings.density : "comfortable";

  // `masterEnabled` records what the user asked for and is preserved as authored.
  // It is deliberately *not* forced off when no profile happens to be enabled:
  // that is the normal "engine on, nothing selected yet" state, and rewriting the
  // flag here would make the master toggle silently fail to stick across reloads.
  // There is no security cost, because rules are applied per enabled profile, so an
  // empty `activeProfileIds` compiles to zero declarativeNetRequest rules.

  return {
    version: CURRENT_VERSION,
    masterEnabled: input.masterEnabled,
    activeProfileIds,
    profiles,
    settings: {
      theme,
      tabScopeDefault,
      density,
      showBadgeCount: settings.showBadgeCount !== false,
    },
  };
}

/**
 * Same contract as {@link validateConfig} but also returns what was repaired, so
 * the UI can tell the user instead of silently changing their rules.
 */
export function normalizeConfig(
  input: unknown,
): { config: AppStorage; warnings: string[] } {
  const report: NormalizeReport = { warnings: [] };
  const config = validateConfig(input, { report });
  return { config, warnings: report.warnings };
}

export async function loadConfig(): Promise<AppStorage> {
  if (window.chrome?.storage?.local) {
    const stored = await window.chrome.storage.local.get(STORAGE_KEY);
    const value = stored[STORAGE_KEY];
    if (value) {
      try {
        return validateConfig(value);
      } catch (error) {
        throw new Error(
          `Stored HeaderForge configuration is invalid. Import a backup or reset it in settings. ${error instanceof Error ? error.message : ""}`.trim(),
        );
      }
    }
    const seeded = cloneConfig(DEFAULT_CONFIG);
    await saveConfig(seeded);
    return seeded;
  }
  try {
    const serialized = window.localStorage.getItem(STORAGE_KEY);
    if (serialized) return validateConfig(JSON.parse(serialized));
  } catch (error) {
    throw new Error(
      `Saved preview configuration is invalid. Import a backup or clear local storage. ${error instanceof Error ? error.message : ""}`.trim(),
    );
  }
  return cloneConfig(DEFAULT_CONFIG);
}

export async function saveConfig(config: AppStorage): Promise<void> {
  const normalized = validateConfig(config);
  if (window.chrome?.storage?.local) {
    await window.chrome.storage.local.set({ [STORAGE_KEY]: normalized });
  } else {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  }
}

export function subscribeToConfig(
  callback: (config: AppStorage) => void,
): () => void {
  if (window.chrome?.storage?.onChanged) {
    const listener = (
      changes: Record<string, { newValue?: unknown }>,
      areaName: string,
    ) => {
      if (areaName !== "local" || !(STORAGE_KEY in changes)) return;
      try {
        callback(validateConfig(changes[STORAGE_KEY].newValue));
      } catch {
        // Ignore malformed external storage changes; loadConfig reports invalid state.
      }
    };
    window.chrome.storage.onChanged.addListener(listener);
    return () => window.chrome?.storage?.onChanged?.removeListener(listener);
  }

  const listener = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      callback(validateConfig(JSON.parse(event.newValue)));
    } catch {
      // Ignore malformed preview storage events.
    }
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}