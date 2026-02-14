import assert from "node:assert/strict";
import test from "node:test";

import { checks } from "./check-ui-guidelines.mjs";

function findCheck(id) {
  const check = checks.find((item) => item.id === id);
  assert.ok(check, `check not found: ${id}`);
  return check;
}

const searchLabelCheck = findCheck("searchbox-labeled");
const deleteAriaLabelCheck = findCheck("settings-delete-aria-label");

test("searchbox-labeled: Fieldタグ上のlabel属性があれば成功", () => {
  const source = `
    <Field label="ゴースト検索">
      <Input />
    </Field>
  `;
  assert.equal(searchLabelCheck.test(source), true);
});

test("searchbox-labeled: 子要素aria-labelのみでは失敗", () => {
  const source = `
    <Field>
      <Input aria-label="ゴースト検索" />
    </Field>
  `;
  assert.equal(searchLabelCheck.test(source), false);
});

test("settings-delete-aria-label: folderを含むテンプレート文字列なら成功", () => {
  const source = `
    <Button aria-label={\`追加フォルダを削除: \${folder}\`}>
      削除
    </Button>
  `;
  assert.equal(deleteAriaLabelCheck.test(source), true);
});

test("settings-delete-aria-label: 固定文言のみなら失敗", () => {
  const source = `
    <Button aria-label={"追加フォルダを削除"}>
      削除
    </Button>
  `;
  assert.equal(deleteAriaLabelCheck.test(source), false);
});
