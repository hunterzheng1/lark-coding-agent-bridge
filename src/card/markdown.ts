/**
 * Shared card-text escaping. Card markdown treats `* _ ` \` as formatting, so
 * model ids / paths / names shown inside markdown elements must escape them.
 * One implementation for all card modules — previously re-declared per file.
 */
export function escapeMd(value: string): string {
  return value.replace(/([*_`\\])/g, '\\$1');
}
