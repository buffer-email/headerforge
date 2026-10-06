import { DEFAULT_CONFIG, STORAGE_KEY, type AppStorage } from "./lib/model";
import {
  activeHeaderCount,
  compileDnrRules,
  DYNAMIC_RULE_ID_START,
  SESSION_RULE_ID_START,
} from "./lib/dnr";
import { validateConfig } from "./lib/storage";
import { truncate } from "./lib/limits";

const STATUS_KEY = "headerforge.status";
const CLOCK_ALARM = "headerforge.refresh-dynamic-headers";
const SYNC_DEBOUNCE_MS = 250;
const BADGE_OK = "#19a974";
const BADGE_IDLE = "#7a8797";
const BADGE_ERROR = "#d17a22";

type Scope = "global" | "tab";

interface StatusRecord {
  ok: boolean;
  activeRules?: number;
  scope?: Scope;
  error?: string;
  warnings?: string[];
  syncedAt: string;
}

let syncQueue: Promise<void> = Promise.resolve();
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Fingerprint of the rule set currently installed in the browser. Comparing this
 * before touching DNR is what stops every keystroke (and every tab switch) from
 * shipping a full rule set across the process boundary.
 */
let installedFingerprint = "";
let installedBadgeText: string | undefined;
let installedBadgeColor: string | undefined;
let installedTitle: string | undefined;
/** Cached so a tab switch can decide whether it needs to do any work at all. */
let lastKnownScope: Scope | undefined;

async function readConfig(): Promise<AppStorage> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  if (!stored[STORAGE_KEY]) {
    await chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_CONFIG });
    return DEFAULT_CONFIG;
  }
  return validateConfig(stored[STORAGE_KEY]);
}

async function getActiveTabId(): Promise<number | undefined> {
  // `tabs` permission is not requested, so Tab objects expose `id` only - which
  // is all declarativeNetRequest needs.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}

/** Coalesces overlapping sync requests into a single trailing run. */
function scheduleSync(delay = 0): void {
  if (delay <= 0) {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    syncQueue = syncQueue.then(runSyncSafely).catch(() => undefined);
    return;
  }
  if (debounceTimer !== undefined) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    syncQueue = syncQueue.then(runSyncSafely).catch(() => undefined);
  }, delay);
}

async function runSyncSafely(): Promise<void> {
  try {
    await syncFromStorage();
  } catch {
    // syncFromStorage handles its own reporting; swallow to keep the queue alive.
  }
}

/**
 * Stable fingerprint of an applied rule set. Cheap to compute and stable across
 * worker restarts, unlike object identity.
 */
function fingerprint(rules: HeaderForgeDnrRule[]): string {
  let hash = 2166136261;
  const mix = (text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  };
  for (const rule of rules) {
    mix(String(rule.id));
    mix(String(rule.priority));
    const headers = rule.action.requestHeaders ?? rule.action.responseHeaders ?? [];
    mix(rule.action.requestHeaders ? "q" : "s");
    for (const header of headers) {
      mix(`${header.header}:${header.operation}:${header.value ?? ""};`);
    }
    mix(rule.condition.urlFilter ?? rule.condition.regexFilter ?? "*");
    mix((rule.condition.resourceTypes ?? []).join(","));
    mix((rule.condition.tabIds ?? []).join(","));
    mix(rule.condition.isUrlFilterCaseSensitive ? "1" : "0");
  }
  return `${rules.length}:${(hash >>> 0).toString(36)}`;
}

async function writeStatus(status: StatusRecord): Promise<void> {
  try {
    await chrome.storage.local.set({ [STATUS_KEY]: status });
  } catch {
    // Status is advisory; never let it break rule synchronisation.
  }
}

async function applyBadge(text: string, color: string, title: string): Promise<void> {
  // Only cross the process boundary when something actually changed.
  const updates: Array<Promise<void>> = [];
  if (installedBadgeText !== text) {
    installedBadgeText = text;
    updates.push(chrome.action.setBadgeText({ text }));
  }
  if (installedBadgeColor !== color) {
    installedBadgeColor = color;
    updates.push(chrome.action.setBadgeBackgroundColor({ color }));
  }
  if (installedTitle !== title) {
    installedTitle = title;
    updates.push(chrome.action.setTitle({ title }));
  }
  await Promise.all(updates);
}

/**
 * One of the two DNR rule stores HeaderForge owns.
 *
 * Rule stores are scoped per extension, so `list()` only ever returns rules this
 * extension installed: enumerating and removing by id is exactly equivalent to
 * "remove everything we own", with no risk of touching another extension's
 * rules.
 */
interface RuleStore {
  /** Every rule currently installed in this store. */
  list: () => Promise<HeaderForgeDnrRule[]>;
  /** Applies a single atomic remove-and/or-add update. */
  update: (options: HeaderForgeRuleUpdate) => Promise<void>;
}

const DYNAMIC_STORE: RuleStore = {
  list: () => chrome.declarativeNetRequest.getDynamicRules(),
  update: (options) => chrome.declarativeNetRequest.updateDynamicRules(options),
};

const SESSION_STORE: RuleStore = {
  list: () => chrome.declarativeNetRequest.getSessionRules(),
  update: (options) => chrome.declarativeNetRequest.updateSessionRules(options),
};

/**
 * Upper bound on `removeRuleIds` per call.
 *
 * Chrome accepts arbitrarily large arrays, but a full 4,500-rule budget is a
 * single oversized IPC payload to parse and validate, and a mid-way failure
 * would strand everything left in the unsent tail. Removing in chunks bounds
 * each payload and bounds the damage: at worst one chunk survives a failure,
 * and the caller's error path re-enumerates and finishes the job.
 */
const REMOVE_CHUNK_SIZE = 500;

/**
 * Replaces the entire contents of a rule store with `next`.
 *
 * Chrome has no "remove all" flag — `removeAllRules` is not part of
 * `UpdateRuleOptions` and Chromium rejects it outright — so removing means
 * enumerating the installed ids first and passing them back as `removeRuleIds`.
 *
 * Removals and additions are deliberately separate calls rather than one fused
 * `removeRuleIds` + `addRules`. Rule ids are handed out deterministically
 * (`ruleIdStart + index`), so the incoming set usually overlaps the outgoing set;
 * Chromium happens to accept that overlap and lets the added rule win, but
 * relying on it would mean the new rule set is only as atomic as the last
 * removal chunk. Splitting keeps the invariant simple: once this resolves, every
 * stale rule is gone and every current rule is installed.
 *
 * Empty inputs are skipped rather than sent as a no-op update, so syncing an
 * already-correct (typically empty) store costs zero DNR round trips.
 */
async function replaceStore(store: RuleStore, next: HeaderForgeDnrRule[]): Promise<void> {
  const staleIds = (await store.list()).map((rule) => rule.id);
  for (let offset = 0; offset < staleIds.length; offset += REMOVE_CHUNK_SIZE) {
    await store.update({ removeRuleIds: staleIds.slice(offset, offset + REMOVE_CHUNK_SIZE) });
  }
  if (next.length) {
    await store.update({ addRules: next });
  }
}

async function replaceAllRules(config: AppStorage): Promise<void> {
  const scope: Scope = config.settings.tabScopeDefault;
  lastKnownScope = scope;
  const tabId = scope === "tab" ? await getActiveTabId() : undefined;
  const tabIds = tabId === undefined ? undefined : [tabId];

  const activeRules =
    scope === "tab" && tabIds
      ? compileDnrRules(config, { tabIds, ruleIdStart: SESSION_RULE_ID_START })
      : compileDnrRules(config, { ruleIdStart: DYNAMIC_RULE_ID_START });

  if (scope === "tab" && tabId === undefined) {
    // No tab to scope to: clear everything rather than leak global rules.
    await clearOwnedRules();
    await refreshStatus(config, 0, [], scope);
    return;
  }

  const nextFingerprint = `${scope}:${fingerprint(activeRules.rules)}`;
  if (nextFingerprint === installedFingerprint) {
    // Rule set is byte-identical; skip the DNR round trip entirely.
    await refreshStatus(config, activeRules.rules.length, activeRules.problems, scope);
    return;
  }

  // Dynamic and session stores are mutually exclusive: whichever scope is not
  // active is emptied so a previous configuration cannot leak rules across a
  // global <-> tab scope switch.
  if (scope === "tab") {
    await replaceStore(DYNAMIC_STORE, []);
    await replaceStore(SESSION_STORE, activeRules.rules);
  } else {
    await replaceStore(SESSION_STORE, []);
    await replaceStore(DYNAMIC_STORE, activeRules.rules);
  }
  installedFingerprint = nextFingerprint;

  // `{{$timestamp}}` and `{{$isoDate}}` are baked into the compiled rules, so
  // they go stale without a periodic recompile. Only schedule the wake-up when
  // something actually needs it; Chrome clamps the period to 1 minute minimum.
  if (activeRules.usesClockTokens) {
    await chrome.alarms.create(CLOCK_ALARM, { periodInMinutes: 1 });
  } else {
    await chrome.alarms.clear(CLOCK_ALARM);
  }

  await refreshStatus(config, activeRules.rules.length, activeRules.problems, scope);
}

async function refreshStatus(
  config: AppStorage,
  ruleCount: number,
  problems: string[],
  scope: Scope,
): Promise<void> {
  const count = activeHeaderCount(config);
  await applyBadge(
    config.settings.showBadgeCount ? String(count) : "",
    config.masterEnabled && count > 0 ? BADGE_OK : BADGE_IDLE,
    `HeaderForge — ${config.masterEnabled ? `${count} active header${count === 1 ? "" : "s"}` : "paused"}`,
  );
  await writeStatus({
    ok: true,
    activeRules: ruleCount,
    scope,
    warnings: problems.length ? problems.map((problem) => truncate(problem, 160)) : undefined,
    syncedAt: new Date().toISOString(),
  });
}

async function clearOwnedRules(): Promise<void> {
  await replaceStore(DYNAMIC_STORE, []);
  await replaceStore(SESSION_STORE, []);
  installedFingerprint = "";
}

async function setError(message: string): Promise<void> {
  const safe = truncate(message, 120);
  installedFingerprint = "";
  await applyBadge("!", BADGE_ERROR, `HeaderForge — rule error: ${safe}`);
  await writeStatus({ ok: false, error: safe, syncedAt: new Date().toISOString() });
}

async function syncFromStorage(): Promise<void> {
  try {
    await replaceAllRules(await readConfig());
  } catch (error) {
    try {
      await clearOwnedRules();
    } catch {
      // Keep the original rule error visible if Chromium also rejects cleanup.
    }
    await setError(error instanceof Error ? error.message : String(error));
  }
}

chrome.runtime.onInstalled.addListener(() => scheduleSync());
chrome.runtime.onStartup.addListener(() => {
  // The worker restarted, so the in-memory fingerprint is unknown. Force a
  // reconcile rather than trusting it.
  installedFingerprint = "";
  scheduleSync();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !(STORAGE_KEY in changes)) return;
  // Typing in a rule editor produces a storage write per character. Debounce so
  // the DNR engine sees one update per pause, not one per keystroke.
  scheduleSync(SYNC_DEBOUNCE_MS);
});

chrome.tabs.onActivated.addListener(() => {
  // Only tab-scoped configurations depend on which tab is active. Global scope
  // must not recompile on every tab switch.
  if (lastKnownScope !== "tab") return;
  scheduleSync(SYNC_DEBOUNCE_MS);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLOCK_ALARM) scheduleSync();
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
    installedFingerprint = "";
    scheduleSync();
  }
  return false;
});