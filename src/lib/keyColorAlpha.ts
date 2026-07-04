// KeyColor 透過アルゴリズム。
// 左上ピクセルをキー色として読み取り、一致するピクセルを透明化する。
// RGBA 配列（ImageData.data 形式）を破壊的に書き換える。
export function applyKeyColorAlpha(data: Uint8ClampedArray): void {
  const keyR = data[0];
  const keyG = data[1];
  const keyB = data[2];
  const keyA = data[3];
  // 左上が不透明でない = 画像が本物のアルファチャンネルを持つ。
  // このときキー色（透明ピクセルの RGB は読み戻しで (0,0,0) に化ける）で
  // 抜くと黒い線画・髪などが消えるため、native alpha を尊重して抜かない。
  if (keyA < 255) return;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] === keyR && data[i + 1] === keyG && data[i + 2] === keyB) {
      data[i + 3] = 0;
    }
  }
}
