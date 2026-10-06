import {
  MAX_FILTERS_PER_PROFILE,
  MAX_HEADERS_PER_PROFILE,
  MAX_PROFILES,
} from "./limits";

export const STORAGE_KEY = "headerforge.config";
export const CURRENT_VERSION = "1.1.0";

export const RESOURCE_TYPES = [
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
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];
export type RuleType = "request" | "response";
export type HeaderOperation = "set" | "append" | "remove";
export type TabScope = "global" | "tab";
export type ThemeSetting = "system" | "dark" | "light";
export type Density = "comfortable" | "compact" | "dense";
export type ColorTag =
  | "teal"
  | "violet"
  | "amber"
  | "orange"
  | "rose"
  | "blue"
  | "slate";

export const COLOR_TAGS: readonly ColorTag[] = [
  "teal",
  "violet",
  "amber",
  "orange",
  "rose",
  "blue",
  "slate",
];

export const DENSITIES: readonly Density[] = ["comfortable", "compact", "dense"];

export function isDensity(value: unknown): value is Density {
  return typeof value === "string" && (DENSITIES as readonly string[]).includes(value);
}

export function isColorTag(value: unknown): value is ColorTag {
  return typeof value === "string" && (COLOR_TAGS as readonly string[]).includes(value);
}

export interface HeaderRule {
  id: string;
  enabled: boolean;
  type: RuleType;
  operation: HeaderOperation;
  name: string;
  value: string;
  resourceTypes: ResourceType[];
}

export interface FilterCondition {
  id: string;
  urlPattern: string;
  isRegex: boolean;
  resourceTypes: ResourceType[];
}

export interface Profile {
  id: string;
  name: string;
  colorTag: string;
  enabled: boolean;
  headers: HeaderRule[];
  filters: FilterCondition[];
}

export interface AppStorage {
  version: string;
  masterEnabled: boolean;
  activeProfileIds: string[];
  profiles: Profile[];
  settings: {
    theme: ThemeSetting;
    showBadgeCount: boolean;
    tabScopeDefault: TabScope;
    /** Row height preset; purely presentational, safe to change at any time. */
    density: Density;
  };
}

export const DEFAULT_CONFIG: AppStorage = {
  version: CURRENT_VERSION,
  masterEnabled: false,
  activeProfileIds: [],
  profiles: [
    {
      id: "profile-staging",
      name: "Staging API",
      colorTag: "violet",
      enabled: false,
      headers: [
        {
          id: "header-auth",
          enabled: false,
          type: "request",
          operation: "set",
          name: "Authorization",
          value: "Bearer your-token-here",
          resourceTypes: ["xmlhttprequest"],
        },
        {
          id: "header-tenant",
          enabled: false,
          type: "request",
          operation: "set",
          name: "X-Tenant-ID",
          value: "acme-test",
          resourceTypes: ["xmlhttprequest"],
        },
      ],
      filters: [
        {
          id: "filter-staging",
          urlPattern: "https://*.staging.example.com/*",
          isRegex: false,
          resourceTypes: [],
        },
      ],
    },
    {
      id: "profile-cors",
      name: "CORS testing",
      colorTag: "orange",
      enabled: false,
      headers: [
        {
          id: "header-cors",
          enabled: false,
          type: "response",
          operation: "set",
          name: "Access-Control-Allow-Origin",
          value: "*",
          resourceTypes: ["xmlhttprequest"],
        },
      ],
      filters: [],
    },
  ],
  settings: {
    theme: "system",
    showBadgeCount: true,
    tabScopeDefault: "global",
    density: "comfortable",
  },
};

export function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function cloneConfig(config: AppStorage): AppStorage {
  return structuredClone(config);
}

/**
 * Total number of header rules across every profile. This is the number that
 * actually costs Chromium DNR evaluation time, so the UI surfaces it directly.
 */
export function totalHeaderCount(config: AppStorage): number {
  return config.profiles.reduce((total, profile) => total + profile.headers.length, 0);
}

export function countEnabledRules(config: AppStorage): number {
  if (!config.masterEnabled) return 0;
  const activeIds = new Set(config.activeProfileIds);
  return config.profiles
    .filter((profile) => profile.enabled && activeIds.has(profile.id))
    .reduce(
      (total, profile) =>
        total + profile.headers.filter((header) => header.enabled).length,
      0,
    );
}

/** Cheap pre-flight check so the UI can warn before a config is written to disk. */
export function withinCollectionLimits(config: {
  profiles: Array<{ headers: unknown[]; filters: unknown[] }>;
}): boolean {
  if (config.profiles.length > MAX_PROFILES) return false;
  return config.profiles.every(
    (profile) =>
      profile.headers.length <= MAX_HEADERS_PER_PROFILE &&
      profile.filters.length <= MAX_FILTERS_PER_PROFILE,
  );
}
