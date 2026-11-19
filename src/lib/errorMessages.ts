import type { TFunction } from "i18next";
import type { CommandError } from "../types/generated/CommandError";

type KnownKind = Exclude<CommandError["kind"], "internal">;

/// 捕まえたエラーを、文言にする前の値のまま state に持つための箱。翻訳済みの文字列を持つと、
/// 言語を切り替えても前の言語の文言が残るため、文言は描画時に組み立てる。
/// reject 値が falsy（空文字・null 等）でも「エラーあり」を表せるよう包む。
export interface CaughtError {
  cause: unknown;
}

/// コマンドエラーの種別 → i18n キー。Record で全種別の網羅をコンパイル時に縛る
/// （Rust 側に種別を足して TS 型を再生成すると、ここが埋まるまで型検査が落ちる）。
const KIND_KEYS: Record<KnownKind, string> = {
  sspExeNotFound: "error.sspExeNotFound",
  sspLaunchFailed: "error.sspLaunchFailed",
  ghostFolderNotFound: "error.ghostFolderNotFound",
  ghostFolderNotDirectory: "error.ghostFolderNotDirectory",
  ghostFolderUnreadable: "error.ghostFolderUnreadable",
  ghostIdentityCollision: "error.ghostIdentityCollision",
};

function isCommandError(error: unknown): error is CommandError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { kind?: unknown }).kind === "string"
  );
}

/// エラーを UI の言語の 1 文にする。Tauri の invoke は Rust のエラー値をそのまま reject するため、
/// 種別つきのコマンドエラー（オブジェクト）・Error・その他の値のいずれも受ける。
/// 未知の種別（型の再生成漏れ等）と internal は、詳細をそのまま返す。
export function describeError(error: unknown, t: TFunction): string {
  if (isCommandError(error)) {
    const key = error.kind === "internal" ? undefined : KIND_KEYS[error.kind];
    if (key) return t(key, { ...error });
    return "detail" in error && typeof error.detail === "string" ? error.detail : JSON.stringify(error);
  }
  return error instanceof Error ? error.message : String(error);
}

/// 定型文の末尾に添える「（詳細: …）」。詳細が空なら空文字を返す。
export function formatErrorDetail(error: unknown, t: TFunction): string {
  const detail = describeError(error, t).trim();
  return detail ? t("error.detail", { detail }) : "";
}

/// スキャン失敗の文言。再操作の手段（再読込ボタン）をロケール側で `$t(header.refresh)` 参照する。
export function buildScanErrorMessage(error: unknown, t: TFunction): string {
  return t("error.scanFailed", { detail: formatErrorDetail(error, t) });
}
