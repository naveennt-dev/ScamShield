// node:fs, node:path, node:dns, node:http(s), node:os, node:child_process are never used on the
// device (no file access, no network inspection). Any call fails loudly instead of pretending.
const fail = (name: string) => () => { throw new Error(`${name} is not available on the device`); };
export const readFile = fail("fs.readFile");
export const lookup = fail("dns.lookup");
export const request = fail("http.request");
export const spawn = fail("child_process.spawn");
export const isAbsolute = (p: string) => p.startsWith("/");
export const join = (...p: string[]) => p.join("/").replace(/\/+/g, "/");
export const tmpdir = () => "/tmp";
const mod = { readFile, lookup, request, spawn, isAbsolute, join, tmpdir, promises: { readFile } };
export default mod;
