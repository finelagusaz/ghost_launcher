export function getFingerprintCacheKey(requestKey: string): string {
  return `fingerprint_${requestKey}`;
}

export function getCachedFingerprint(requestKey: string): string | null {
  return localStorage.getItem(getFingerprintCacheKey(requestKey));
}

export function setCachedFingerprint(requestKey: string, fingerprint: string): void {
  localStorage.setItem(getFingerprintCacheKey(requestKey), fingerprint);
}

export function pruneFingerprintCache(keepRequestKeys: string[]): void {
  const keepKeys = new Set(keepRequestKeys.map(getFingerprintCacheKey));
  const toRemove: string[] = [];

  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith("fingerprint_")) {
      continue;
    }
    if (!keepKeys.has(key)) {
      toRemove.push(key);
    }
  }

  for (const key of toRemove) {
    localStorage.removeItem(key);
  }
}
