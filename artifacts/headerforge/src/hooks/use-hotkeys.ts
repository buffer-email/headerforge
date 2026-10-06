import { useEffect, useRef } from "react";

export interface Hotkey {
  /** Lowercase `KeyboardEvent.key`, or a Space-separated alias list. */
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  handler: (event: KeyboardEvent) => void;
  /** When false the shortcut is ignored. Defaults to true. */
  enabled?: boolean;
  /** Fire even if the event target is an input, textarea, or select. */
  allowInInputs?: boolean;
}

function matches(event: KeyboardEvent, hotkey: Hotkey): boolean {
  if (event.key.toLowerCase() !== hotkey.key.toLowerCase()) return false;
  if (Boolean(hotkey.meta) !== (event.metaKey || event.ctrlKey)) return false;
  if (Boolean(hotkey.ctrl) !== event.ctrlKey) return false;
  if (Boolean(hotkey.shift) !== event.shiftKey) return false;
  if (hotkey.alt !== undefined && hotkey.alt !== event.altKey) return false;
  return true;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Registers global keyboard shortcuts.
 *
 * The options dashboard is a dense keyboard-first surface, so every destructive
 * or navigational action is reachable without leaving the home row. Shortcuts
 * are suppressed while typing in a field unless explicitly opted in, which stops
 * `n` from inserting a header into the search box mid-keystroke.
 */
export function useHotkeys(hotkeys: Hotkey[], deps: readonly unknown[] = []): void {
  const latest = useRef(hotkeys);
  latest.current = hotkeys;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const typing = isTextEntry(event.target);
      for (const hotkey of latest.current) {
        if (hotkey.enabled === false) continue;
        if (typing && !hotkey.allowInInputs) continue;
        if (!matches(event, hotkey)) continue;
        event.preventDefault();
        hotkey.handler(event);
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Shortcut hint text for display, e.g. "Mod+K". */
export function formatHotkey(hotkey: Pick<Hotkey, "key" | "meta" | "ctrl" | "shift" | "alt">): string {
  const parts: string[] = [];
  const isMac =
    typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform);
  if (hotkey.meta || hotkey.ctrl) parts.push(isMac ? "⌘" : "Ctrl");
  if (hotkey.shift) parts.push(isMac ? "⇧" : "Shift");
  if (hotkey.alt) parts.push(isMac ? "⌥" : "Alt");
  parts.push(hotkey.key === " " ? "Space" : hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key);
  return parts.join(isMac ? "" : "+");
}