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

test("searchbox-labeled: t()によるlabel属性があれば成功", () => {
  const source = `
    <Field label={t("search.label")}>
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

// 文言は i18n リソースが単一権威。直書きの日本語は、folder を含んでいても英語の UI に日本語を出す
test("settings-delete-aria-label: folderを含んでも直書きのテンプレート文字列なら失敗", () => {
  const source = `
    <Button aria-label={\`追加フォルダを削除: \${folder}\`}>
      削除
    </Button>
  `;
  assert.equal(deleteAriaLabelCheck.test(source), false);
});

test("settings-delete-aria-label: t()にfolderを渡す形式なら成功", () => {
  const source = `
    <Button aria-label={t("settings.folders.deleteAriaLabel", { folder })}>
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

const scanErrorCheck = findCheck("scan-error-actionable");

test("scan-error-actionable: error.scanFailed が $t(header.refresh) を参照すれば成功", () => {
  const source = JSON.stringify({ "error.scanFailed": "失敗しました。「$t(header.refresh)」を実行してください。{{detail}}" });
  assert.equal(scanErrorCheck.test(source), true);
});

test("scan-error-actionable: ボタン名の直書きは失敗", () => {
  const source = JSON.stringify({ "error.scanFailed": "失敗しました。「再読込」を実行してください。{{detail}}" });
  assert.equal(scanErrorCheck.test(source), false);
});

test("scan-error-actionable: キーが無ければ失敗", () => {
  const source = JSON.stringify({ "header.refresh": "$t(header.refresh)" });
  assert.equal(scanErrorCheck.test(source), false);
});

test("scan-error-actionable: 同梱ロケールの全ファイルが対象になる", () => {
  const files = scanErrorCheck.files();
  assert.ok(files.includes("src/locales/ja.json"));
  assert.ok(files.includes("src/locales/en.json"));
  assert.ok(files.every((file) => file.endsWith(".json")));
});
