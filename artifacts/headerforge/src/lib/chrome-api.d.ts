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

interface HeaderForgeChromeApi {
  storage: {
    local: {
      get: (keys?: string | string[]) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
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
    updateDynamicRules: (options: {
      removeRuleIds?: number[];
      addRules?: HeaderForgeDnrRule[];
    }) => Promise<void>;
    updateSessionRules: (options: {
      removeRuleIds?: number[];
      addRules?: HeaderForgeDnrRule[];
    }) => Promise<void>;
  };
  action: {
    setBadgeText: (details: { text: string }) => Promise<void>;
    setBadgeBackgroundColor: (details: { color: string }) => Promise<void>;
    setTitle: (details: { title: string }) => Promise<void>;
  };
  tabs: {
    query: (queryInfo: {
      active?: boolean;
      lastFocusedWindow?: boolean;
    }) => Promise<Array<{ id?: number }>>;
    onActivated: {
      addListener: (callback: () => void) => void;
    };
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
  };
  alarms: {
    create: (
      name: string,
      alarmInfo: { periodInMinutes: number },
    ) => Promise<void>;
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
