/**
 * Rimuove gli slash finali da una URL senza usare una regex non ancorata
 * (vulnerabile a ReDoS su input con molte ripetizioni di '/').
 */
export function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}
