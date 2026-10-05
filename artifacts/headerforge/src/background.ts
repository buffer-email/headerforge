import {
  DEFAULT_CONFIG,
  STORAGE_KEY,
  type AppStorage,
} from "./lib/model";
import {
  activeHeaderCount,
  compileDnrRules,
  DYNAMIC_RULE_ID_START,
  MAX_HEADERFORGE_RULES,
  SESSION_RULE_ID_START,
} from "./lib/dnr";
import { validateConfig } from "./lib/storage";

const STATUS_KEY = "headerforge.status";
const CLOCK_ALARM = "headerforge.refresh-dynamic-headers";

let syncQueue = Promise.resolve();

async function readConfig(): Promise<AppStorage> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  if (!stored[STORAGE_KEY]) {
    await chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_CONFIG });
    return DEFAULT_CONFIG;
  }
  return validateConfig(stored[STORAGE_KEY]);
}

async function getActiveTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}

function appendSequential(task: () => Promise<void>): void {
  syncQueue = syncQueue.then(task).catch((error: unknown) => {
    void setError(error instanceof Error ? error.message : String(error));
  });
}

async function replaceRules(config: AppStorage): Promise<void> {
  const count = activeHeaderCount(config);
  let compiled;
  if (config.settings.tabScopeDefault === "tab") {
    const tabId = await getActiveTabId();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: Array.from(
        { length: MAX_HEADERFORGE_RULES },
        (_, index) => DYNAMIC_RULE_ID_START + index,
      ),
      addRules: [],
    });
    const result = tabId === undefined
      ? { rules: [], usesClockTokens: false }
      : compileDnrRules(config, {
          tabIds: [tabId],
          ruleIdStart: SESSION_RULE_ID_START,
        });
    compiled = result;
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: Array.from(
        { length: MAX_HEADERFORGE_RULES },
        (_, index) => SESSION_RULE_ID_START + index,
      ),
      addRules: result.rules,
    });
  } else {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: Array.from(
        { length: MAX_HEADERFORGE_RULES },
        (_, index) => SESSION_RULE_ID_START + index,
      ),
      addRules: [],
    });
    const result = compileDnrRules(config, {
      ruleIdStart: DYNAMIC_RULE_ID_START,
    });
    compiled = result;
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: Array.from(
        { length: MAX_HEADERFORGE_RULES },
        (_, index) => DYNAMIC_RULE_ID_START + index,
      ),
      addRules: result.rules,
    });
  }

  if (compiled.usesClockTokens) {
    await chrome.alarms.create(CLOCK_ALARM, { periodInMinutes: 1 });
  } else {
    await chrome.alarms.clear(CLOCK_ALARM);
  }
  await chrome.action.setBadgeText({
    text: config.settings.showBadgeCount ? String(count) : "",
  });
  await chrome.action.setBadgeBackgroundColor({
    color: config.masterEnabled && count > 0 ? "#19a974" : "#7a8797",
  });
  await chrome.action.setTitle({
    title: `HeaderForge — ${config.masterEnabled ? `${count} active header${count === 1 ? "" : "s"}` : "paused"}`,
  });
  await chrome.storage.local.set({
    [STATUS_KEY]: {
      ok: true,
      activeRules: count,
      scope: config.settings.tabScopeDefault,
      syncedAt: new Date().toISOString(),
    },
  });
}

async function clearOwnedRules(): Promise<void> {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: Array.from(
      { length: MAX_HEADERFORGE_RULES },
      (_, index) => DYNAMIC_RULE_ID_START + index,
    ),
    addRules: [],
  });
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: Array.from(
      { length: MAX_HEADERFORGE_RULES },
      (_, index) => SESSION_RULE_ID_START + index,
    ),
    addRules: [],
  });
}

async function setError(message: string): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: "#d17a22" });
  await chrome.action.setBadgeText({ text: "!" });
  await chrome.action.setTitle({ title: `HeaderForge — rule error: ${message}` });
  await chrome.storage.local.set({
    [STATUS_KEY]: {
      ok: false,
      error: message,
      syncedAt: new Date().toISOString(),
    },
  });
}

async function syncFromStorage(): Promise<void> {
  try {
    await replaceRules(await readConfig());
  } catch (error) {
    try {
      await clearOwnedRules();
    } catch {
      // Keep the original rule error visible if Chromium also rejects cleanup.
    }
    await setError(error instanceof Error ? error.message : String(error));
  }
}

chrome.runtime.onInstalled.addListener(() => {
  appendSequential(syncFromStorage);
});

chrome.runtime.onStartup.addListener(() => {
  appendSequential(syncFromStorage);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && STORAGE_KEY in changes) {
    appendSequential(syncFromStorage);
  }
});

chrome.tabs.onActivated.addListener(() => {
  appendSequential(async () => {
    const config = await readConfig();
    if (config.settings.tabScopeDefault === "tab") {
      await replaceRules(config);
    }
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLOCK_ALARM) appendSequential(syncFromStorage);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "GET_HEADERFORGE_STATUS"
  ) {
    chrome.storage.local.get(STATUS_KEY).then((data) => {
      sendResponse(data[STATUS_KEY] ?? { ok: true, activeRules: 0 });
    });
    return true;
  }
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "CONFIG_UPDATED"
  ) {
    appendSequential(syncFromStorage);
  }
  return false;
});
