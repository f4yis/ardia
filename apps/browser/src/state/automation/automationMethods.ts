import type { BrowserCommand } from "../../platform/commands";
import type { BrowserState } from "../browser/store";
import { automationCommands, automationDecision, isCatalogCommand, variantsOf } from "./automationCommands";
import { activeTabId } from "../browser/model";
import { choicesFor, listingOf, nounOf, pickChoice, takesChoice } from "./commandChoices";
import { COMMANDS, LITTLE_ARDIA_PAGE_COMMANDS } from "../commands/commandCatalog";
import { eligibleKind, isEligibleTab, lastFocusedEligibleWindow } from "./automationWindows";
import { AUTOMATION_EVENTS, MIN_IDLE_SECONDS, NAMED_ONLY_EVENTS, type AutomationEventName } from "./eventNames";

export const PROTOCOL = 4;
export const MIN_CLIENT_PROTOCOL = 4;

export type ErrorCode = "bad_request" | "unknown_method" | "unknown_command" | "refused" | "no_window" | "failed" | "password_manager_plugin" | "unsupported_protocol";
export type MethodError = { code: ErrorCode; message: string };
export type RequestId = number | string | null;
export type ParsedRequest = { id: RequestId; method: string; params: Record<string, unknown> };
export type RunPlan = { command: BrowserCommand; arg: string | null; windowId: string | null; tabId: string | null };
export type Subscription = {
  events: ReadonlySet<AutomationEventName>;
  fullUrls: boolean;
  tabIdle: ReadonlySet<number>;
  userIdle: ReadonlySet<number>;
  hooks: unknown;
};

export const failure = (code: ErrorCode, message: string) => ({ error: { code, message } satisfies MethodError });

const isFields = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const MAX_ID_BYTES = 256;

const utf8 = new TextEncoder();

function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    }
  }
  return true;
}

const usableId = (id: unknown): id is number | string =>
  typeof id === "string" ? id.length <= MAX_ID_BYTES && wellFormed(id) && utf8.encode(id).length <= MAX_ID_BYTES : typeof id === "number" && Number.isSafeInteger(id);

export function parseRequest(line: string): ParsedRequest | { id: RequestId; error: MethodError } {
  let doc: unknown;
  try {
    doc = JSON.parse(line);
  } catch {
    return { id: null, ...failure("bad_request", "The line isn't JSON.") };
  }
  if (!isFields(doc)) return { id: null, ...failure("bad_request", "A request is a JSON object.") };
  const id = doc.id;
  if (!usableId(id)) return { id: null, ...failure("bad_request", `A request needs an id: a safe integer, or a well-formed string of at most ${MAX_ID_BYTES} UTF-8 bytes.`) };
  if (typeof doc.method !== "string") return { id, ...failure("bad_request", "A request needs a method.") };
  if (doc.params !== undefined && !isFields(doc.params)) return { id, ...failure("bad_request", "params must be an object.") };
  return { id, method: doc.method, params: (doc.params as Record<string, unknown> | undefined) ?? {} };
}

export const hello = (version: string) => ({ app: "Ardia", version, protocol: PROTOCOL, minClientProtocol: MIN_CLIENT_PROTOCOL });

export function clientProtocolProblem(params: Record<string, unknown>, version: string): MethodError | null {
  const asked = params.protocol === undefined ? PROTOCOL : params.protocol;
  if (typeof asked !== "number" || !Number.isSafeInteger(asked) || asked < 1) return { code: "bad_request", message: "protocol must be a whole number." };
  if (asked >= MIN_CLIENT_PROTOCOL) return null;
  return { code: "unsupported_protocol", message: `This ardia command speaks control protocol ${asked}, and Ardia ${version} needs ${MIN_CLIENT_PROTOCOL} or later: update the command (Settings › Plugins, or its install.sh).` };
}

export const commands = automationCommands;

const REFUSALS: Record<string, string> = {
  endsApp: "ends the app",
  changesEngine: "changes which engine shows a page",
  leftOutSetting: "changes a setting config files can't set",
  control: "touches control itself",
  needsArgument: "needs an argument the socket doesn't pass",
  needsPerson: "needs the person to finish it",
};

const TAB_COMMANDS: ReadonlySet<string> = new Set(["closeTab", "togglePin", "moveTabUp", "moveTabDown", "duplicateTab", "bookmarkPage"]);

const scopeOf = (command: BrowserCommand) => (COMMANDS as Readonly<Record<string, { scope?: string }>>)[command]?.scope ?? null;

const ELSEWHERE: Partial<Record<string, string>> = {
  moveTabToProfile: " `ardia tabs move <tab> --profile <profile>` moves tabs to another profile, without asking.",
  moveTabToWindow: " `ardia tabs move <tab> --window <window>` moves tabs to another window.",
};

type Target = { windowId: string | null; tabId: string | null };

function runTarget(s: BrowserState, command: BrowserCommand, window: unknown, tab: unknown): Target | { error: MethodError } {
  if (tab !== undefined && tab !== null) {
    if (typeof tab !== "string" || !isEligibleTab(s, tab)) return failure("no_window", `There's no tab ${String(tab)} the ardia command can use.`);
    if (scopeOf(command) !== "page" && !TAB_COMMANDS.has(command)) return failure("bad_request", `${command} doesn't act on a tab, so it takes no tab.`);
    const windowId = s.tabs[tab]!.windowId;
    if (eligibleKind(s, windowId) === "little" && command !== "closeTab" && !LITTLE_ARDIA_PAGE_COMMANDS.has(command)) {
      return failure("bad_request", `${command} doesn't work on a Little Ardia tab.`);
    }
    if (window !== undefined && window !== null && window !== windowId) return failure("no_window", `Tab ${tab} isn't in window ${String(window)}.`);
    return { windowId, tabId: tab };
  }
  if (window !== undefined && window !== null) {
    if (typeof window !== "string" || !eligibleKind(s, window)) return failure("no_window", `There's no window ${String(window)} the ardia command can use.`);
    return { windowId: window, tabId: null };
  }
  const target = lastFocusedEligibleWindow(s);
  if (target) return { windowId: target, tabId: null };
  if (s.windowOrder.length === 0) return { windowId: null, tabId: null };
  return failure("no_window", "No window the ardia command can use is open.");
}

function chosen(s: BrowserState, command: BrowserCommand, arg: unknown, target: Target): string | { error: MethodError } {
  const noun = nounOf(command);
  if (typeof arg !== "string" || !arg.trim()) return failure("bad_request", `${command} needs a ${noun}: ${listingOf(command)} lists them.`);
  if (!target.windowId) return failure("no_window", `${command} needs a window, and none the ardia command can use is open.`);
  const tabId = target.tabId ?? activeTabId(s, target.windowId) ?? null;
  return pickChoice(choicesFor(s, command, { windowId: target.windowId, tabId }), arg, noun, listingOf(command));
}

export function planRun(s: BrowserState, params: Record<string, unknown>): RunPlan | { error: MethodError } {
  const { command, arg, window, tab } = params;
  if (typeof command !== "string" || !command) return failure("bad_request", "run needs a command id.");
  if (!isCatalogCommand(command)) return failure("unknown_command", `There's no command ${command}.`);
  const decision = automationDecision(command);
  if (decision !== "run") return failure("refused", `${command} ${REFUSALS[decision]}, so the ardia command can't run it.${ELSEWHERE[command] ?? ""}`);
  const choosing = takesChoice(command);
  if (!choosing && arg !== undefined && arg !== null) {
    const variants = variantsOf(command);
    if (typeof arg !== "string" || !variants?.includes(arg)) {
      return failure("bad_request", variants ? `${command} takes one of: ${variants.join(", ")}.` : `${command} takes no argument.`);
    }
  }
  const target = runTarget(s, command, window, tab);
  if ("error" in target) return target;
  if (!choosing) return { command, arg: (arg as string | null | undefined) ?? null, ...target };
  const picked = chosen(s, command, arg, target);
  return typeof picked === "string" ? { command, arg: picked, ...target } : picked;
}

export function choicesMethod(s: BrowserState, params: Record<string, unknown>) {
  const { command, window, tab } = params;
  const unknown = Object.keys(params).filter((key) => key !== "command" && key !== "window" && key !== "tab");
  if (unknown.length) return failure("bad_request", `choices takes command, window and tab, not ${unknown.join(", ")}.`);
  if (typeof command !== "string" || !command) return failure("bad_request", "choices needs a command id.");
  if (!isCatalogCommand(command)) return failure("unknown_command", `There's no command ${command}.`);
  if (!takesChoice(command) || automationDecision(command) !== "run") {
    const variants = automationDecision(command) === "run" ? variantsOf(command) : null;
    return { result: { command, window: null, kind: variants ? "variants" : "none", choices: (variants ?? []).map((id) => ({ id, title: id })) } };
  }
  const target = runTarget(s, command, window, tab);
  if ("error" in target) return target;
  if (!target.windowId) return failure("no_window", `${command} needs a window, and none the ardia command can use is open.`);
  const tabId = target.tabId ?? activeTabId(s, target.windowId) ?? null;
  return { result: { command, window: target.windowId, kind: nounOf(command), choices: choicesFor(s, command, { windowId: target.windowId, tabId }) } };
}

const KNOWN_EVENTS: ReadonlySet<string> = new Set(AUTOMATION_EVENTS);
const MAX_THRESHOLDS = 8;

function thresholds(value: unknown): Set<number> | null {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.length > MAX_THRESHOLDS || !value.every((v) => Number.isSafeInteger(v) && v >= MIN_IDLE_SECONDS && v <= 7 * 86400)) return null;
  return new Set(value as number[]);
}

export function parseSubscription(params: Record<string, unknown>): Subscription | { error: MethodError } {
  const { events, fullUrls, idle, hooks } = params;
  if (!Array.isArray(events) || !events.every((name) => typeof name === "string")) return failure("bad_request", "subscribe needs events: a list of event names, or [\"*\"].");
  const unknown = events.filter((name) => name !== "*" && !KNOWN_EVENTS.has(name));
  if (unknown.length) return failure("bad_request", `Unknown events: ${unknown.join(", ")}. Events: ${AUTOMATION_EVENTS.join(", ")}.`);
  const named = events.filter((name) => name !== "*") as AutomationEventName[];
  const all = events.includes("*") ? AUTOMATION_EVENTS.filter((name) => !NAMED_ONLY_EVENTS.has(name)) : [];
  if (fullUrls !== undefined && typeof fullUrls !== "boolean") return failure("bad_request", "fullUrls must be true or false.");
  const idleFields = idle === undefined ? {} : idle;
  if (typeof idleFields !== "object" || idleFields === null || Array.isArray(idleFields)) return failure("bad_request", "idle is {\"tab\": [seconds], \"user\": [seconds]}.");
  const tabIdle = thresholds((idleFields as Record<string, unknown>).tab);
  const userIdle = thresholds((idleFields as Record<string, unknown>).user);
  if (!tabIdle || !userIdle) return failure("bad_request", `idle thresholds are lists of at most ${MAX_THRESHOLDS} whole seconds, at least ${MIN_IDLE_SECONDS}.`);
  return { events: new Set([...all, ...named]), fullUrls: fullUrls === true, tabIdle, userIdle, hooks };
}
