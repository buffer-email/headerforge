import {
  cloneConfig,
  createId,
  CURRENT_VERSION,
  RESOURCE_TYPES,
  type AppStorage,
  type FilterCondition,
  type HeaderRule,
  type Profile,
  type ResourceType,
} from "./model";
import {
  MAX_FILTERS_PER_PROFILE,
  MAX_HEADERS_PER_PROFILE,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_CHARS,
  MAX_PROFILES,
} from "./limits";
import { coerceEnabledFlag, normalizeConfig } from "./storage";

export { MAX_IMPORT_BYTES };

export type ImportFormat = "headerforge" | "modheader";

export interface ParsedImport {
  config: AppStorage;
  format: ImportFormat;
  warnings: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

/**
 * Legacy exports spell booleans inconsistently, and the string `"false"` is
 * truthy in JavaScript — reading it with `!== false` silently *enables* a
 * profile the author disabled. Only recognised spellings are honoured.
 */
function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return fallback;
  }
  if (typeof value === "string") {
    switch (value.trim().toLowerCase()) {
      case "true":
      case "yes":
      case "1":
        return true;
      case "false":
      case "no":
      case "0":
        return false;
      default:
        return fallback;
    }
  }
  return fallback;
}

/**
 * Guards untrusted text before it reaches `JSON.parse`. Returns the text with a
 * UTF-8 BOM removed so callers can hand it straight to `parseConfigurationImport`.
 */
export function readImportText(raw: string): string {
  if (raw.length > MAX_IMPORT_CHARS) {
    throw new Error(
      `Import is larger than ${(MAX_IMPORT_BYTES / (1024 * 1024)).toLocaleString()} MB. Export a single profile instead.`,
    );
  }
  // Windows editors prepend a BOM, which JSON.parse rejects outright.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // V8 quotes a slice of the document inside its SyntaxError; keep only the
    // offset so nothing from the user's file is echoed back to them.
    const offset = /at position (\d+)/.exec(error instanceof Error ? error.message : "")?.[1];
    throw new Error(
      `That is not valid JSON.${offset ? ` The problem starts around character ${offset}.` : ""}`,
    );
  }
  // A bare number/string/null is never a configuration; a top-level array is
  // still a supported ModHeader export, so it is allowed through.
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Expected a JSON object or an array of header rules, but found a bare value.");
  }
  return text;
}

function legacyResourceTypes(raw: Record<string, unknown>): ResourceType[] {
  const candidate = raw.resourceTypes ?? raw.resourceType ?? raw.resources;
  const values = Array.isArray(candidate)
    ? candidate
    : typeof candidate === "string"
      ? [candidate]
      : [];
  const allowed = new Set<ResourceType>(RESOURCE_TYPES);
  return values.filter(
    (value): value is ResourceType =>
      typeof value === "string" && allowed.has(value as ResourceType),
  );
}

/** Shared budget for one legacy parse: see {@link claimVisit}. */
interface LegacyWalk {
  warnings: string[];
  visited: number;
}

/**
 * Backstop on the total number of entries one legacy parse may look at. The
 * per-collection caps count only *accepted* rules, so a document padded with
 * junk entries would otherwise be scanned end to end; this caps that scan at
 * the largest configuration the limits can legitimately produce, which keeps a
 * valid export importable while a hostile one still terminates quickly. The `+1`
 * covers the profile node itself alongside its headers and filters.
 */
const MAX_LEGACY_NODES = MAX_PROFILES * (MAX_HEADERS_PER_PROFILE + MAX_FILTERS_PER_PROFILE + 1);

function claimVisit(walk: LegacyWalk): boolean {
  walk.visited += 1;
  if (walk.visited <= MAX_LEGACY_NODES) return true;
  if (walk.visited === MAX_LEGACY_NODES + 1) {
    walk.warnings.push(
      `Import is too complex to read fully; parsing stopped after ${MAX_LEGACY_NODES.toLocaleString()} entries.`,
    );
  }
  return false;
}

function parseLegacyFilters(value: unknown, walk: LegacyWalk): FilterCondition[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : value == null
        ? []
        : [value];
  const filters: FilterCondition[] = [];
  for (const entry of entries) {
    if (filters.length >= MAX_FILTERS_PER_PROFILE) {
      walk.warnings.push(
        `Only the first ${MAX_FILTERS_PER_PROFILE.toLocaleString()} URL filters were imported.`,
      );
      break;
    }
    if (!claimVisit(walk)) break;
    const item = typeof entry === "string" ? { urlPattern: entry } : record(entry);
    if (!item) continue;
    const pattern = nonEmptyString(
      item.urlPattern,
      item.urlRegex,
      item.regex,
      item.pattern,
      item.url,
      item.include,
    );
    if (!pattern) continue;
    filters.push({
      id: createId("filter"),
      urlPattern: pattern,
      isRegex:
        coerceBoolean(item.isRegex, false) ||
        coerceBoolean(item.regex, false) ||
        typeof item.urlRegex === "string",
      resourceTypes: legacyResourceTypes(item),
    });
  }
  return filters;
}

function parseLegacyHeader(
  value: unknown,
  profile: Record<string, unknown>,
): HeaderRule | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const name = nonEmptyString(raw.name, raw.header, raw.key);
  if (!name) return undefined;

  const rawType = String(raw.type ?? raw.kind ?? "request").toLowerCase();
  const type = rawType.includes("response") ? "response" : "request";
  const requestedOperation = String(raw.operation ?? raw.action ?? "").toLowerCase();
  const operation =
    requestedOperation === "remove" || coerceBoolean(raw.remove, false)
      ? "remove"
      : requestedOperation === "append" ||
          coerceBoolean(raw.appendMode, false) ||
          coerceBoolean(profile.appendMode, false)
        ? "append"
        : "set";
  return {
    id: createId("header"),
    // Absent means enabled, which is how ModHeader treats a rule it stores. A value
    // that is present but unreadable must not turn rewriting on, so it fails closed.
    enabled: coerceEnabledFlag(raw.enabled, true).value,
    type,
    operation,
    name,
    value: typeof raw.value === "string" ? raw.value : "",
    resourceTypes: legacyResourceTypes(raw),
  };
}

function parseLegacyProfile(
  value: unknown,
  index: number,
  walk: LegacyWalk,
): Profile | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const name =
    nonEmptyString(raw.name, raw.title, raw.profileName) ?? `Imported profile ${index + 1}`;
  const headersSource = Array.isArray(raw.headers)
    ? raw.headers
    : Array.isArray(raw.rules)
      ? raw.rules
      : [];
  const headers: HeaderRule[] = [];
  for (const entry of headersSource) {
    if (headers.length >= MAX_HEADERS_PER_PROFILE) {
      walk.warnings.push(
        `"${name}" had more than ${MAX_HEADERS_PER_PROFILE.toLocaleString()} header rules; only the first ${MAX_HEADERS_PER_PROFILE.toLocaleString()} were imported.`,
      );
      break;
    }
    if (!claimVisit(walk)) break;
    const header = parseLegacyHeader(entry, raw);
    if (header) headers.push(header);
  }
  // `disabled: true` is the only field that can veto an enabled profile.
  const enabled =
    coerceEnabledFlag(raw.enabled, true).value && !coerceBoolean(raw.disabled, false);
  return {
    id: createId("profile"),
    name,
    colorTag: nonEmptyString(raw.colorTag, raw.color) ?? "blue",
    enabled,
    headers,
    filters: parseLegacyFilters(raw.filters ?? raw.filter, walk),
  };
}

function parseModHeader(
  value: unknown,
): { config: AppStorage; warnings: string[] } | undefined {
  const walk: LegacyWalk = { warnings: [], visited: 0 };
  const top = record(value);
  const wrapped: Record<string, unknown> | undefined = top
    ? record(top.data) ?? top
    : undefined;
  const flatHeaderArray =
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => {
      const item = record(entry);
      return (
        !!item &&
        !!nonEmptyString(item.name, item.header, item.key) &&
        !Array.isArray(item.headers) &&
        !Array.isArray(item.rules) &&
        !Array.isArray(item.profiles)
      );
    });
  const rawProfiles: unknown[] | undefined = Array.isArray(value)
    ? flatHeaderArray
      ? [{ name: "Imported ModHeader rules", headers: value }]
      : value
    : Array.isArray(wrapped?.profiles)
      ? wrapped.profiles
      : wrapped &&
          (Array.isArray(wrapped.headers) || Array.isArray(wrapped.rules))
        ? [wrapped]
        : undefined;
  if (!rawProfiles) return undefined;

  const profiles: Profile[] = [];
  for (let index = 0; index < rawProfiles.length; index += 1) {
    if (profiles.length >= MAX_PROFILES) {
      walk.warnings.push(
        `Import declared more than ${MAX_PROFILES.toLocaleString()} profiles; only the first ${MAX_PROFILES.toLocaleString()} were imported.`,
      );
      break;
    }
    if (!claimVisit(walk)) break;
    const profile = parseLegacyProfile(rawProfiles[index], index, walk);
    if (profile) profiles.push(profile);
  }
  if (!profiles.length) return undefined;

  const activeProfileIds = profiles
    .filter((profile) => profile.enabled)
    .map((profile) => profile.id);
  const masterEnabled = coerceEnabledFlag(wrapped?.masterEnabled, true).value;
  const config: AppStorage = {
    version: CURRENT_VERSION,
    masterEnabled,
    activeProfileIds,
    profiles,
    settings: {
      theme: "system",
      showBadgeCount: true,
      tabScopeDefault: "global",
      density: "comfortable",
    },
  };
  return { config, warnings: walk.warnings };
}

export function parseConfigurationImport(input: unknown): ParsedImport {
  try {
    const { config, warnings } = normalizeConfig(input);
    return { config, format: "headerforge", warnings };
  } catch {
    const legacy = parseModHeader(input);
    if (legacy) {
      // ModHeader data is the least trustworthy input we accept, so the parsed
      // result goes back through normalisation for the same repairs and caps
      // that protect a native backup.
      const { config, warnings } = normalizeConfig(legacy.config);
      return { config, format: "modheader", warnings: [...legacy.warnings, ...warnings] };
    }
    throw new Error(
      "This file is not a HeaderForge backup or a supported ModHeader export.",
    );
  }
}

export function applyImportedConfig(
  current: AppStorage,
  incoming: AppStorage,
  mode: "merge" | "replace",
): AppStorage {
  // `incoming` may have come straight from a hostile backup, so re-validate it
  // in both modes: neither merge nor replace may install an over-limit or
  // malformed configuration.
  const source = normalizeConfig(incoming).config;
  if (mode === "replace") return cloneConfig(source);

  // Imported profiles are appended so the user's own ordering is untouched.
  // Chromium derives DNR rule priority from array order, so appended rules are
  // evaluated *below* the existing ones; reordering after import is the fix.
  const room = Math.max(0, MAX_PROFILES - current.profiles.length);
  const kept = source.profiles.slice(0, room);
  const importedProfiles = kept.map((profile) => ({
    ...profile,
    id: createId("profile"),
    headers: profile.headers.map((header) => ({
      ...header,
      id: createId("header"),
    })),
    filters: profile.filters.map((filter) => ({
      ...filter,
      id: createId("filter"),
    })),
  }));
  const profileIdMap = new Map(
    kept.map((sourceProfile, index) => [sourceProfile.id, importedProfiles[index].id]),
  );
  const profiles = [...current.profiles, ...importedProfiles];
  const active = new Set<string>([
    ...current.activeProfileIds,
    ...source.activeProfileIds
      .map((id) => profileIdMap.get(id))
      .filter((id): id is string => id !== undefined),
  ]);
  return {
    ...current,
    version: CURRENT_VERSION,
    profiles,
    // Same convention as App's toggleProfile/reorderProfiles: derive the list
    // from `profiles` so it stays deduplicated and in profile order.
    activeProfileIds: profiles.filter((profile) => active.has(profile.id)).map((profile) => profile.id),
  };
}
