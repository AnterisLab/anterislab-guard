/**
 * Removes trailing slashes from a URL without using an unanchored regex
 * (vulnerable to ReDoS on input with many repetitions of '/').
 */
export function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}
