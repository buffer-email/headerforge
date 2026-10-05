import {
  cloneConfig,
  createId,
  CURRENT_VERSION,
  type AppStorage,
  type FilterCondition,
  type HeaderRule,
  type Profile,
  type ResourceType,
} from "./model";
import { validateConfig } from "./storage";

type ImportFormat = "headerforge" | "modheader";

export interface ParsedImport {
  config: AppStorage;
  format: ImportFormat;
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

function legacyResourceTypes(raw: Record<string, unknown>): ResourceType[] {
  const candidate = raw.resourceTypes ?? raw.resourceType ?? raw.resources;
  const values = Array.isArray(candidate)
    ? candidate
    : typeof candidate === "string"
      ? [candidate]
      : [];
  const allowed = new Set<ResourceType>([
    "main_frame",
    "sub_frame",
    "stylesheet",
    "script",
    "image",
    "font",
    "object",
    "xmlhttprequest",
    "ping",
    "csp_report",
    "media",
    "websocket",
    "other",
  ]);
  return values.filter(
    (value): value is ResourceType =>
      typeof value === "string" && allowed.has(value as ResourceType),
  );
}

function parseLegacyFilters(value: unknown): FilterCondition[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : value == null
        ? []
        : [value];
  return entries.flatMap((entry) => {
    const item = typeof entry === "string" ? { urlPattern: entry } : record(entry);
    if (!item) return [];
    const pattern = nonEmptyString(
      item.urlPattern,
      item.urlRegex,
      item.regex,
      item.pattern,
      item.url,
      item.include,
    );
    if (!pattern) return [];
    return [
      {
        id: createId("filter"),
        urlPattern: pattern,
        isRegex:
          item.isRegex === true ||
          item.regex === true ||
          typeof item.urlRegex === "string",
        resourceTypes: legacyResourceTypes(item),
      },
    ];
  });
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
    requestedOperation === "remove" || raw.remove === true
      ? "remove"
      : requestedOperation === "append" ||
          raw.appendMode === true ||
          profile.appendMode === true
        ? "append"
        : "set";
  return {
    id: createId("header"),
    enabled: raw.enabled !== false,
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
): Profile | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const headersSource = Array.isArray(raw.headers)
    ? raw.headers
    : Array.isArray(raw.rules)
      ? raw.rules
      : [];
  const headers = headersSource
    .map((header) => parseLegacyHeader(header, raw))
    .filter((header): header is HeaderRule => header !== undefined);
  const enabled = raw.enabled !== false && raw.disabled !== true;
  return {
    id: createId("profile"),
    name: nonEmptyString(raw.name, raw.title, raw.profileName) ?? `Imported profile ${index + 1}`,
    colorTag: nonEmptyString(raw.colorTag, raw.color) ?? "blue",
    enabled,
    headers,
    filters: parseLegacyFilters(raw.filters ?? raw.filter),
  };
}

function parseModHeader(value: unknown): AppStorage | undefined {
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

  const profiles = rawProfiles
    .map((profile, index) => parseLegacyProfile(profile, index))
    .filter((profile): profile is Profile => profile !== undefined);
  if (!profiles.length) return undefined;

  const activeProfileIds = profiles
    .filter((profile) => profile.enabled)
    .map((profile) => profile.id);
  return {
    version: CURRENT_VERSION,
    masterEnabled: wrapped?.masterEnabled !== false && activeProfileIds.length > 0,
    activeProfileIds,
    profiles,
    settings: {
      theme: "system",
      showBadgeCount: true,
      tabScopeDefault: "global",
    },
  };
}

export function parseConfigurationImport(input: unknown): ParsedImport {
  try {
    return { config: validateConfig(input), format: "headerforge" };
  } catch {
    const legacy = parseModHeader(input);
    if (legacy) return { config: legacy, format: "modheader" };
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
  if (mode === "replace") return cloneConfig(incoming);

  const importedProfiles = incoming.profiles.map((profile) => ({
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
    incoming.profiles.map((source, index) => [source.id, importedProfiles[index].id]),
  );
  return {
    ...current,
    version: CURRENT_VERSION,
    profiles: [...current.profiles, ...importedProfiles],
    activeProfileIds: [
      ...current.activeProfileIds,
      ...incoming.activeProfileIds
        .map((id) => profileIdMap.get(id))
        .filter((id): id is string => id !== undefined),
    ],
  };
}
