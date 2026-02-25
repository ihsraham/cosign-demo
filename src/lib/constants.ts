export const SEPOLIA_CHAIN_ID = 11155111;
export const ALLOWED_ASSETS = new Set(['usdc', 'weth']);
export const DEFAULT_ROOM_TTL_HOURS = 24;

export function ttlDate(hours: number = DEFAULT_ROOM_TTL_HOURS): string {
  const date = new Date();
  date.setHours(date.getHours() + hours);
  return date.toISOString();
}
