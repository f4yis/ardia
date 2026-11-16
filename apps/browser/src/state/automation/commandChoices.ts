import type { BrowserCommand } from "../../platform/commands";
import type { BrowserState } from "../browser/store";
import type { BookmarkNode, Bookmarks } from "../browser/types";
import { bookmarkProfileId, engineProfile, isIncognitoProfile, tabLabel } from "../browser/model";
import { engineBookmarkRoots, folderChildren } from "../bookmarks/bookmarks";
import { isBookmarklet } from "../bookmarks/bookmarklets";
import { extensionMenu } from "../extensions/actions";
import { closedWindowTitle, recentlyClosedIn } from "../windows/recentlyClosedList";
import { failure, type MethodError } from "./automationMethods";

export type Choice = { id: string; title: string; detail?: string; current?: boolean };

type Context = { windowId: string; tabId: string | null };

const MAX_FOLDER_DEPTH = 32;

export function profileChoices(s: Pick<BrowserState, "profiles" | "profileOrder">, currentId?: string): Choice[] {
  return s.profileOrder
    .filter((id) => s.profiles[id] && !isIncognitoProfile(id))
    .map((id) => ({ id, title: s.profiles[id]!.name, ...(id === currentId ? { current: true } : {}) }));
}

function bookmarkChoices(b: Bookmarks, engine: string): Choice[] {
  const roots = engineBookmarkRoots(b, engine);
  if (!roots) return [];
  const out: Choice[] = [];
  const walk = (folderId: string, path: string[]) => {
    if (path.length > MAX_FOLDER_DEPTH) return;
    for (const node of folderChildren(b, folderId) as BookmarkNode[]) {
      if (node.kind === "folder") walk(node.id, [...path, node.title]);
      else if (!isBookmarklet(node.url)) out.push({ id: node.id, title: node.title || node.url, detail: [...path, node.url].join(" › ") });
    }
  };
  walk(roots.bar, ["Bookmarks Bar"]);
  walk(roots.other, ["Other Bookmarks"]);
  return out;
}

function closedChoices(s: BrowserState): Choice[] {
  const list = recentlyClosedIn(s, undefined);
  const named = (profileId: string | undefined, rest: string) => {
    const name = profileId && s.profiles[profileId] ? s.profiles[profileId]!.name : null;
    return name ? `${rest} · ${name}` : rest;
  };
  const shown = (profileId: string | undefined) => !profileId || !isIncognitoProfile(profileId);
  const entries = [
    ...list.tabs.map((c) => ({ at: c.closedAt, choice: { id: c.id, title: c.tab.title || tabLabel(c.tab), detail: named(c.tab.profileId, `tab · ${c.tab.url}`) } })),
    ...list.windows.filter((c) => shown(c.window.profileId)).map((c) => ({ at: c.closedAt, choice: { id: c.id, title: closedWindowTitle(c), detail: named(c.window.profileId, "window") } })),
    ...list.groups.filter((c) => shown(c.tabs[0]?.profileId)).map((c) => ({
      at: c.closedAt,
      choice: { id: c.id, title: c.group.name || "Group", detail: named(c.tabs[0]?.profileId, `group · ${c.tabs.length} tab${c.tabs.length === 1 ? "" : "s"}`) },
    })),
  ];
  return entries.sort((a, b) => b.at - a.at).map((e) => e.choice);
}

const CHOOSERS: Partial<Record<BrowserCommand, (s: BrowserState, at: Context) => Choice[]>> = {
  switchProfile: (s, at) => profileChoices(s, s.windows[at.windowId]?.profileId),
  openBookmark: (s, at) => bookmarkChoices(s.bookmarks, engineProfile(s, bookmarkProfileId(s, s.windows[at.windowId]))),
  restoreClosed: (s) => closedChoices(s),
  openExtension: (s, at) => extensionMenu(s, at.windowId).map((x) => ({ id: x.id, title: x.title })),
};

export const takesChoice = (command: BrowserCommand) => Object.hasOwn(CHOOSERS, command);

export const choicesFor = (s: BrowserState, command: BrowserCommand, at: Context): Choice[] => CHOOSERS[command]?.(s, at) ?? [];

const folded = (text: string) => text.trim().toLocaleLowerCase();

const NOUNS: Partial<Record<BrowserCommand, string>> = {
  switchProfile: "profile",
  openBookmark: "bookmark",
  restoreClosed: "recently closed item",
  openExtension: "extension",
};

export const nounOf = (command: BrowserCommand) => NOUNS[command] ?? "choice";

const TITLES: Partial<Record<BrowserCommand, string>> = {
  switchProfile: "Switch to Profile",
  openBookmark: "Open Bookmark",
  restoreClosed: "Reopen Recently Closed Item",
  openExtension: "Open Extension",
};

export const choiceTitle = (command: BrowserCommand) => TITLES[command];

export const listingOf = (command: BrowserCommand) => (command === "switchProfile" ? "`ardia profiles`" : `\`ardia commands ${command}\``);

export function pickChoice(choices: Choice[], ref: string, noun: string, listing: string): string | { error: MethodError } {
  if (choices.some((c) => c.id === ref)) return ref;
  const want = folded(ref);
  if (!want) return failure("bad_request", `Name a ${noun}; ${listing} lists them.`);
  const tiers = [
    choices.filter((c) => folded(c.title) === want),
    choices.filter((c) => c.detail !== undefined && folded(c.detail.split(" › ").at(-1)!) === want),
    choices.filter((c) => folded(c.title).includes(want) || (c.detail !== undefined && folded(c.detail).includes(want))),
  ];
  const found = tiers.find((tier) => tier.length > 0) ?? [];
  if (found.length === 1) return found[0]!.id;
  if (!found.length) return failure("no_window", `There's no ${noun} matching ${JSON.stringify(ref)}; ${listing} lists them.`);
  const shown = found.slice(0, 8).map((c) => `${c.id} (${JSON.stringify(c.title)})`).join(", ");
  return failure("bad_request", `${JSON.stringify(ref)} matches ${found.length} ${noun}s: ${shown}${found.length > 8 ? ", …" : ""}. Give its id.`);
}

export function resolveProfile(s: Pick<BrowserState, "profiles" | "profileOrder">, ref: string): string | { error: MethodError } {
  return pickChoice(profileChoices(s), ref, "profile", "`ardia profiles`");
}
