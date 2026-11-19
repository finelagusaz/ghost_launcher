import { describe, it, expect, vi } from "vitest";
import { convertFileSrc } from "@tauri-apps/api/core";
import { thumbnailUrl, THUMBNAIL_SCHEME } from "./thumbnailUrl";

describe("thumbnailUrl", () => {
  it("サムネイル用のプロトコルで URL にする（asset プロトコルは使わない）", () => {
    const path = String.raw`C:\SSP\ghost\a\thumbnail.png`;
    const url = thumbnailUrl(path);
    expect(vi.mocked(convertFileSrc)).toHaveBeenCalledWith(path, THUMBNAIL_SCHEME);
    expect(url.startsWith(`${THUMBNAIL_SCHEME}://`)).toBe(true);
  });
});
