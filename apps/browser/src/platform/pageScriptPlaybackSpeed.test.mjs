import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../../../../packages/ardiacore/ios/page_script.js", import.meta.url), "utf8");
const pick = (name) => {
  const source = script.match(new RegExp(`const ${name} = (\\([^)]*\\) => [\\s\\S]*?);\\n {2}[^\\s}]`))?.[1];
  assert.ok(source, `page_script.js defines ${name}`);
  return new Function(`return ${source}`)();
};
const nextSpeed = pick("nextSpeed");
const speedStep = pick("speedStep");
const typingIn = pick("typingIn");

test("S and D step the speed by 0.1 between 0.1× and 16×", () => {
  assert.equal(nextSpeed(1, 0.1), 1.1);
  assert.equal(nextSpeed(1.2, -0.1), 1.1);
  assert.equal(nextSpeed(0.1, -0.1), 0.1);
  assert.equal(nextSpeed(16, 0.1), 16);
  assert.equal(nextSpeed(1.25, 0.1), 1.4, "a site's own 1.25× rounds to the next tenth");
});

test("only a bare S or D counts, with Caps Lock too, never with a modifier or while composing", () => {
  const key = (k, extra = {}) => speedStep({ key: k, ...extra });
  assert.equal(key("d"), 0.1);
  assert.equal(key("s"), -0.1);
  assert.equal(key("S"), -0.1);
  for (const mod of ["metaKey", "ctrlKey", "altKey", "shiftKey", "isComposing"]) assert.equal(key("s", { [mod]: true }), 0, mod);
  assert.equal(key("a"), 0);
});

test("typing in a field or an editable page never changes the speed", () => {
  assert.equal(typingIn({ tagName: "INPUT" }), true);
  assert.equal(typingIn({ tagName: "TEXTAREA" }), true);
  assert.equal(typingIn({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(typingIn({ tagName: "VIDEO" }), false);
  assert.equal(typingIn(null), false);
});
