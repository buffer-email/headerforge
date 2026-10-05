import {
  cloneConfig,
  CURRENT_VERSION,
  DEFAULT_CONFIG,
  RESOURCE_TYPES,
  STORAGE_KEY,
  type AppStorage,
  type ResourceType,
} from "./model";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateConfig(input: unknown): AppStorage {
  if (!isRecord(input) || !Array.isArray(input.profiles)) {
    throw new Error("This file is not a valid HeaderForge configuration.");
  }
  if (typeof input.masterEnabled !== "boolean") {
    throw new Error("Configuration is missing the global enablement setting.");
  }

  const profileIds = new Set<string>();
  const profiles = input.profiles.map((raw, index) => {
    if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id) {
      throw new Error(`Profile ${index + 1} is missing a valid ID.`);
    }
    if (profileIds.has(raw.id)) {
      throw new Error(`Duplicate profile ID: ${raw.id}`);
    }
    profileIds.add(raw.id);
    if (!Array.isArray(raw.headers) || !Array.isArray(raw.filters)) {
      throw new Error(`Profile ${index + 1} has invalid rules or filters.`);
    }
    const headers = raw.headers.map((header, headerIndex) => {
      if (
        !isRecord(header) ||
        typeof header.id !== "string" ||
        typeof header.enabled !== "boolean" ||
        (header.type !== "request" && header.type !== "response") ||
        !["set", "append", "remove"].includes(String(header.operation)) ||
        typeof header.name !== "string" ||
        typeof header.value !== "string" ||
        !Array.isArray(header.resourceTypes) ||
        !header.resourceTypes.every(
          (type) =>
            typeof type === "string" &&
            RESOURCE_TYPES.includes(type as ResourceType),
        )
      ) {
        throw new Error(
          `Profile ${index + 1}, header ${headerIndex + 1} is invalid.`,
        );
      }
      return {
        id: header.id,
        enabled: header.enabled,
        type: header.type as "request" | "response",
        operation: header.operation as "set" | "append" | "remove",
        name: header.name,
        value: header.value,
        resourceTypes: header.resourceTypes as AppStorage["profiles"][number]["headers"][number]["resourceTypes"],
      };
    });
    const filters = raw.filters.map((filter, filterIndex) => {
      if (
        !isRecord(filter) ||
        typeof filter.id !== "string" ||
        typeof filter.urlPattern !== "string" ||
        typeof filter.isRegex !== "boolean" ||
        !Array.isArray(filter.resourceTypes) ||
        !filter.resourceTypes.every(
          (type) =>
            typeof type === "string" &&
            RESOURCE_TYPES.includes(type as ResourceType),
        )
      ) {
        throw new Error(
          `Profile ${index + 1}, URL filter ${filterIndex + 1} is invalid.`,
        );
      }
      return {
        id: filter.id,
        urlPattern: filter.urlPattern,
        isRegex: filter.isRegex,
        resourceTypes: filter.resourceTypes as AppStorage["profiles"][number]["filters"][number]["resourceTypes"],
      };
    });
    return {
      id: raw.id,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name : "Imported profile",
      colorTag: typeof raw.colorTag === "string" ? raw.colorTag : "blue",
      enabled: Boolean(raw.enabled),
      headers,
      filters,
    };
  });

  const activeProfileIds = Array.isArray(input.activeProfileIds)
    ? input.activeProfileIds.filter(
        (id): id is string => typeof id === "string" && profileIds.has(id),
      )
    : [];
  const settings = isRecord(input.settings) ? input.settings : {};
  const theme =
    settings.theme === "dark" || settings.theme === "light"
      ? settings.theme
      : "system";
  const tabScopeDefault = settings.tabScopeDefault === "tab" ? "tab" : "global";

  return {
    version: CURRENT_VERSION,
    masterEnabled: input.masterEnabled,
    activeProfileIds,
    profiles,
    settings: {
      theme,
      tabScopeDefault,
      showBadgeCount: settings.showBadgeCount !== false,
    },
  };
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
    await saveConfig(cloneConfig(DEFAULT_CONFIG));
    return cloneConfig(DEFAULT_CONFIG);
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
