type HeaderForgeRuleCondition = {
  urlFilter?: string;
  regexFilter?: string;
  resourceTypes?: import("./model").ResourceType[];
  tabIds?: number[];
  isUrlFilterCaseSensitive?: boolean;
};

type HeaderForgeHeaderInfo = {
  header: string;
  operation: "append" | "remove" | "set";
  value?: string;
};

type HeaderForgeDnrRule = {
  id: number;
  priority: number;
  action: {
    type: "modifyHeaders";
    requestHeaders?: HeaderForgeHeaderInfo[];
    responseHeaders?: HeaderForgeHeaderInfo[];
  };
  condition: HeaderForgeRuleCondition;
};

/**
 * Options for `updateDynamicRules` / `updateSessionRules`.
 *
 * There is deliberately no "remove everything" flag here, because Chrome has no
 * such flag: `declarativeNetRequest.UpdateRuleOptions` accepts only
 * `removeRuleIds` and `addRules`, and Chromium validates the object strictly and
 * throws `Unexpected property: 'removeAllRules'` on anything else.
 *
 * `removeRuleIds` is therefore the ONLY way to remove an installed rule, which
 * means clearing a rule set requires enumerating it first (via `getDynamicRules`
 * / `getSessionRules`) and passing the resulting ids back. Unknown ids are
 * ignored rather than rejected, so a removal built from a slightly stale read
 * is harmless. A rule id may appear in both `removeRuleIds` and `addRules`, in
 * which case the added rule wins.
 */
type HeaderForgeRuleUpdate = {
  /** Ids of installed rules to remove. Non-existent ids are ignored. */
  removeRuleIds?: number[];
  /** Rules to install. Ids must be unique within this call. */
  addRules?: HeaderForgeDnrRule[];
};

interface HeaderForgeChromeApi {
  storage: {
    local: {
      get: (keys?: string | string[]) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
      remove: (keys: string | string[]) => Promise<void>;
    };
    onChanged: {
      addListener: (
        callback: (
          changes: Record<string, { newValue?: unknown }>,
          areaName: string,
        ) => void,
      ) => void;
      removeListener: (
        callback: (
          changes: Record<string, { newValue?: unknown }>,
          areaName: string,
        ) => void,
      ) => void;
    };
  };
  declarativeNetRequest: {
    updateDynamicRules: (options: HeaderForgeRuleUpdate) => Promise<void>;
    updateSessionRules: (options: HeaderForgeRuleUpdate) => Promise<void>;
    getDynamicRules: () => Promise<HeaderForgeDnrRule[]>;
    getSessionRules: () => Promise<HeaderForgeDnrRule[]>;
  };
  action: {
    setBadgeText: (details: { text: string }) => Promise<void>;
    setBadgeBackgroundColor: (details: { color: string }) => Promise<void>;
    setTitle: (details: { title: string }) => Promise<void>;
  };
  /**
   * Note: HeaderForge does NOT request the `tabs` permission. Tab objects
   * therefore expose only `id`, which is all declarativeNetRequest requires.
   */
  tabs: {
    query: (queryInfo: {
      active?: boolean;
      lastFocusedWindow?: boolean;
    }) => Promise<Array<{ id?: number }>>;
    onActivated: { addListener: (callback: () => void) => void };
  };
  permissions: {
    contains: (permissions: {
      permissions?: string[];
      origins?: string[];
    }) => Promise<boolean>;
  };
  runtime: {
    openOptionsPage: () => Promise<void>;
    onInstalled: { addListener: (callback: () => void) => void };
    onStartup: { addListener: (callback: () => void) => void };
    onMessage: {
      addListener: (
        callback: (
          message: unknown,
          sender: unknown,
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ) => void;
    };
    sendMessage: (message: unknown) => Promise<unknown>;
  };
  alarms: {
    create: (name: string, alarmInfo: { periodInMinutes: number }) => Promise<void>;
    clear: (name: string) => Promise<boolean>;
    onAlarm: {
      addListener: (callback: (alarm: { name: string }) => void) => void;
    };
  };
}

declare const chrome: HeaderForgeChromeApi;

interface Window {
  chrome?: HeaderForgeChromeApi;
}