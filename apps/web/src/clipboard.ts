/**
 * Clipboard helper. `navigator.clipboard` is unavailable over plain HTTP
 * (non-secure contexts), so callers surface a manual-copy fallback instead of
 * failing silently.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
