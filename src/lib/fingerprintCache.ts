export function getFingerprintCacheKey(requestKey: string): string {
  return `fingerprint_${requestKey}`;
}

export function getCachedFingerprint(requestKey: string): string | null {
  return localStorage.getItem(getFingerprintCacheKey(requestKey));
}

export function setCachedFingerprint(requestKey: string, fingerprint: string): void {
  localStorage.setItem(getFingerprintCacheKey(requestKey), fingerprint);
}
