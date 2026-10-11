// Browser replacement for node:net (isIP / isIPv4 / isIPv6), same return values as Node.
const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
export function isIPv4(s: string): boolean { return V4.test(s); }
export function isIPv6(s: string): boolean {
  if (!s.includes(":") || /[^0-9a-fA-F:.]/.test(s.replace(/%.+$/, ""))) return false;
  try { return new URL(`http://[${s.replace(/%.+$/, "")}]/`).hostname.length > 2; } catch { return false; }
}
export function isIP(s: string): 0 | 4 | 6 { return isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0; }
/** Only used by online URL safety checks, which never run on the device. */
export class BlockList { addSubnet(): void {} addAddress(): void {} addRange(): void {} check(): boolean { return true; } }
export default { isIP, isIPv4, isIPv6, BlockList };
