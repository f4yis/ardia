import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { startAutomation } = await import("./controlSocket.ts");
const { automationCommands } = await import("./automationCommands.ts");
const { parseLaunchAction } = await import("./launchActions.ts");
const { pickChoice } = await import("./commandChoices.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let nextId = 0;

async function call(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 9, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, params }) });
  for (let i = 0; i < 50 && !stub.controlSocket.replies.slice(before).some((r) => r.connection === 9); i++) await tick();
  const replies = stub.controlSocket.replies.slice(before).filter((r) => r.connection === 9);
  assert.equal(replies.length, 1, `one reply to ${method}`);
  return JSON.parse(replies[0].line);
}

async function setup() {
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  const work = S().createProfile({ name: "Work" });
  const home = S().createProfile({ name: "Home" });
  const windowId = S().createWindow({ url: "https://a.example/" });
  return { work, home, windowId, own: S().windows[windowId].profileId };
}

test("the four commands that take an item run, list it with choices, and stay out of launchActions", () => {
  const listed = automationCommands();
  for (const id of ["switchProfile", "openBookmark", "restoreClosed", "openExtension"]) {
    const entry = listed.find((c) => c.id === id);
    assert.ok(entry, id);
    assert.equal(entry.choices, true, id);
    assert.equal(typeof parseLaunchAction(id), "string", id);
  }
  assert.equal(listed.find((c) => c.id === "newTab").choices, undefined);
  for (const id of ["addFolderToSidebar", "restoreArcFolders", "addBookmarkToFolder", "moveTabToProfile", "moveTabToWindow"]) assert.ok(!listed.some((c) => c.id === id), id);
});

test("pickChoice takes an id, then an exact name, then a unique part of one, and names the ambiguous", () => {
  const choices = [{ id: "p1", title: "Work" }, { id: "p2", title: "Workshop" }, { id: "p3", title: "Home", detail: "Bar › https://home.example/" }];
  assert.equal(pickChoice(choices, "p2", "profile", "x"), "p2");
  assert.equal(pickChoice(choices, " work ", "profile", "x"), "p1");
  assert.equal(pickChoice(choices, "shop", "profile", "x"), "p2");
  assert.equal(pickChoice(choices, "https://home.example/", "profile", "x"), "p3");
  assert.equal(pickChoice(choices, "wor", "profile", "x").error.code, "bad_request");
  assert.equal(pickChoice(choices, "nothing", "profile", "x").error.code, "no_window");
  assert.equal(pickChoice(choices, "  ", "profile", "x").error.code, "bad_request");
});

test("choices lists profiles with the shown one marked, and run needs one", async () => {
  const { work, home, windowId, own } = await setup();
  const reply = (await call("choices", { command: "switchProfile" })).result;
  assert.equal(reply.window, windowId);
  assert.equal(reply.kind, "profile");
  assert.deepEqual(reply.choices.map((c) => c.id), [own, work, home]);
  assert.equal(reply.choices.find((c) => c.current)?.id, own);
  assert.equal((await call("run", { command: "switchProfile" })).error.code, "bad_request");
  assert.equal((await call("run", { command: "switchProfile", arg: "Nowhere" })).error.code, "no_window");
  assert.equal((await call("choices", { command: "nope" })).error.code, "unknown_command");
  assert.equal((await call("choices", { command: "newTab" })).result.kind, "none");
  assert.deepEqual((await call("choices", { command: "setAppearance" })).result.choices.map((c) => c.id), ["auto", "light", "dark"]);
});

test("moving a tab through run is refused with the tabs move command instead, which never asks", async () => {
  await setup();
  for (const command of ["moveTabToProfile", "moveTabToWindow"]) {
    const refused = (await call("run", { command, arg: "Work" })).error;
    assert.equal(refused.code, "refused", command);
    assert.match(refused.message, /ardia tabs move/, command);
  }
});

test("openBookmark opens a bookmark by its name in the window's tab, and never a bookmarklet", async () => {
  const { windowId, own } = await setup();
  const mark = S().addBookmark({ profileId: own, url: "https://docs.example/guide", title: "The Guide" });
  S().addBookmark({ profileId: own, url: "javascript:alert(1)", title: "A Bookmarklet" });
  const marks = (await call("choices", { command: "openBookmark" })).result.choices;
  assert.ok(marks.some((c) => c.id === mark && c.detail.endsWith("https://docs.example/guide")));
  assert.ok(!marks.some((c) => c.title === "A Bookmarklet"));
  assert.equal((await call("run", { command: "openBookmark", arg: "A Bookmarklet" })).error.code, "no_window");
  assert.deepEqual((await call("run", { command: "openBookmark", arg: "the guide" })).result, { ok: true });
  assert.equal(S().tabs[model.activeTabId(S(), windowId)].page.nav?.url, "https://docs.example/guide");
});

test("restoreClosed reopens what the History menu lists, by name", async () => {
  const { windowId } = await setup();
  const gone = S().newTab(windowId, { url: "https://closed.example/", title: "Closed Page", background: true });
  S().closeTab(gone);
  const closed = (await call("choices", { command: "restoreClosed" })).result.choices;
  assert.ok(closed.some((c) => c.detail?.includes("https://closed.example/")));
  assert.deepEqual((await call("run", { command: "restoreClosed", arg: "closed.example" })).result, { ok: true });
  assert.ok(Object.values(S().tabs).some((t) => t.url === "https://closed.example/"));
});

test("restoreClosed lists every profile's closed items, naming the profile, whichever space the window shows", async () => {
  const { work, windowId } = await setup();
  const elsewhere = S().newTab(windowId, { url: "https://work-only.example/", profileId: work, background: true });
  S().closeTab(elsewhere);
  const item = (await call("choices", { command: "restoreClosed" })).result.choices.find((c) => c.detail?.includes("work-only.example"));
  assert.ok(item);
  assert.match(item.detail, / · Work$/);
});

test("workspace and apply take a profile's name as well as its id", async () => {
  const { work, windowId } = await setup();
  assert.equal((await call("workspace", { profile: "WORK" })).result.profiles.length >= 2, true);
  const opened = (await call("apply", { ops: [{ op: "open", urls: ["https://w.example/"], profile: "Work", window: windowId }] })).result;
  assert.equal(opened.ok, true);
  assert.equal(S().tabs[opened.results[0].tabs[0]].profileId, work);
  const again = (await call("apply", { ops: [{ op: "tab.move", tabs: [opened.results[0].tabs[0]], profile: "home" }] })).result;
  assert.equal(again.ok, true);
  assert.notEqual(S().tabs[opened.results[0].tabs[0]].profileId, work);
  S().createProfile({ name: "work" });
  const twice = (await call("apply", { ops: [{ op: "open", urls: ["https://x.example/"], profile: "work" }] })).result;
  assert.equal(twice.ok, false);
  assert.equal(twice.error.code, "bad_request");
});
