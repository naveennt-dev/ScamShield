// Types for the userland punycode package (used only by the device build's node:url replacement).
declare module "punycode/" {
  const punycode: { encode(input: string): string; decode(input: string): string };
  export default punycode;
}
