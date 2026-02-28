export function getSourceFolderLabel(source: string): string {
  return source.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || source;
}
