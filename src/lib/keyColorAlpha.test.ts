import { describe, it, expect } from "vitest";
import { applyKeyColorAlpha } from "./keyColorAlpha";

describe("applyKeyColorAlpha", () => {
  it("左上が透明（本物のアルファ持ち）の画像はキー色抜きせず、黒ピクセルを残す", () => {
    // pixel0: 完全透明の黒（RGBA 読み戻しで RGB は (0,0,0) になる）
    // pixel1: 不透明の黒（キャラクターの線画・髪など）
    const data = new Uint8ClampedArray([0, 0, 0, 0, /* */ 0, 0, 0, 255]);

    applyKeyColorAlpha(data);

    // 黒消えバグの回帰防止: 不透明な黒ピクセルのアルファは維持される
    expect(data[7]).toBe(255);
    // もともと透明なピクセルは透明のまま
    expect(data[3]).toBe(0);
  });

  it("左上が不透明なキー色（緑）の画像は、一致ピクセルを透明化し黒は残す", () => {
    // pixel0: 不透明の緑（キー色）
    // pixel1: 不透明の黒（キャラクター本体）
    // pixel2: 不透明の緑（背景）
    const data = new Uint8ClampedArray([
      0, 255, 0, 255, /* */ 0, 0, 0, 255, /* */ 0, 255, 0, 255,
    ]);

    applyKeyColorAlpha(data);

    expect(data[3]).toBe(0); // 緑キー色 → 透明
    expect(data[7]).toBe(255); // 黒 → 維持
    expect(data[11]).toBe(0); // 緑キー色 → 透明
  });
});
