export const STORAGE_KEY = "headerforge.config";
export const CURRENT_VERSION = "1.0.0";

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
    theme: "system" | "dark" | "light";
    showBadgeCount: boolean;
    tabScopeDefault: TabScope;
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
  },
};

export function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function cloneConfig(config: AppStorage): AppStorage {
  return structuredClone(config);
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
