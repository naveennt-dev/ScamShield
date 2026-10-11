import { createHash } from "node:crypto";

/**
 * Static download inspection: identify what a file really is from its first bytes ("magic
 * numbers"), compare with the file-name extension and the server's declared MIME type, and hash
 * it. The bytes stay in memory; nothing is written to disk, opened or executed. This is NOT
 * malware analysis — a file can be malicious without any mismatch.
 */

export type FileKind =
  | "windows_executable" | "elf_executable" | "macos_executable" | "android_app" | "java_archive" | "zip"
  | "rar" | "7z" | "gzip" | "pdf" | "office_legacy" | "office_openxml" | "script" | "html" | "image" | "video"
  | "audio" | "text" | "disk_image" | "unknown";

export const EXECUTABLE_KINDS = new Set<FileKind>(["windows_executable", "elf_executable", "macos_executable", "android_app", "java_archive", "script", "disk_image"]);

export function sniffFileKind(b: Buffer): FileKind {
  const hex = b.subarray(0, 16).toString("hex");
  const ascii = b.subarray(0, 512).toString("latin1");
  if (hex.startsWith("4d5a")) return "windows_executable";
  if (hex.startsWith("7f454c46")) return "elf_executable";
  if (/^(feedface|feedfacf|cefaedfe|cffaedfe|cafebabe)/.test(hex)) return hex.startsWith("cafebabe") && b.length > 8 && b.readUInt32BE(4) > 30 ? "java_archive" : "macos_executable";
  if (hex.startsWith("504b0304")) {
    const head = b.subarray(0, Math.min(b.length, 64 * 1024)).toString("latin1");
    if (head.includes("AndroidManifest.xml") || head.includes("classes.dex")) return "android_app";
    if (head.includes("META-INF/MANIFEST.MF")) return "java_archive";
    if (head.includes("[Content_Types].xml") || /word\/|xl\/|ppt\//.test(head)) return "office_openxml";
    return "zip";
  }
  if (hex.startsWith("526172211a07")) return "rar";
  if (hex.startsWith("377abcaf271c")) return "7z";
  if (hex.startsWith("1f8b")) return "gzip";
  if (ascii.startsWith("%PDF-")) return "pdf";
  if (hex.startsWith("d0cf11e0a1b11ae1")) return "office_legacy";
  if (ascii.startsWith("#!") || /^@echo off/i.test(ascii) || /^\s*(powershell|cmd\.exe|Set-ExecutionPolicy)/i.test(ascii)) return "script";
  if (/^\s*(<!doctype html|<html|<head|<body|<script)/i.test(ascii)) return "html";
  if (/^(89504e47|ffd8ff|47494638|52494646.{8}57454250)/.test(hex)) return "image";
  if (/^(000000..66747970|1a45dfa3)/.test(hex)) return "video";
  if (/^(494433|fffb|fff3|4f676753)/.test(hex)) return "audio";
  if (ascii.slice(0x8001, 0x8006) === "CD001" || /^(6b6f6c79)/.test(hex)) return "disk_image";
  if (/^[\x09\x0a\x0d\x20-\x7e]{64}/.test(ascii)) return "text";
  return "unknown";
}

const EXT_KIND: Record<string, FileKind[]> = {
  exe: ["windows_executable"], msi: ["office_legacy", "windows_executable"], scr: ["windows_executable"], dll: ["windows_executable"],
  apk: ["android_app", "zip"], xapk: ["zip", "android_app"], jar: ["java_archive", "zip"], dmg: ["disk_image", "unknown", "gzip"],
  pkg: ["unknown", "zip"], zip: ["zip", "office_openxml", "android_app", "java_archive"], rar: ["rar"], "7z": ["7z"], gz: ["gzip"],
  pdf: ["pdf"], doc: ["office_legacy"], xls: ["office_legacy"], ppt: ["office_legacy"], docx: ["office_openxml", "zip"],
  xlsx: ["office_openxml", "zip"], pptx: ["office_openxml", "zip"], docm: ["office_openxml", "zip"], xlsm: ["office_openxml", "zip"],
  jpg: ["image"], jpeg: ["image"], png: ["image"], gif: ["image"], webp: ["image"], mp4: ["video"], mkv: ["video"], mp3: ["audio"],
  txt: ["text"], csv: ["text"], html: ["html"], htm: ["html"], sh: ["script"], bat: ["script"], cmd: ["script"], ps1: ["script"],
  vbs: ["script", "text"], js: ["script", "text"], iso: ["disk_image"], img: ["disk_image"],
};

export interface DownloadInspection {
  fileName: string | null;
  extension: string | null;
  declaredMime: string | null;
  detectedKind: FileKind;
  sizeDeclared: number | null;
  bytesInspected: number;
  /** SHA-256 of the full file when it was read completely; null when only a prefix was read. */
  sha256: string | null;
  mismatch: string | null;
  executable: boolean;
  doubleExtension: boolean;
  macroCapable: boolean;
}

export function fileNameFrom(url: string, contentDisposition: string | null): string | null {
  const cd = contentDisposition ?? "";
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(cd);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  let name = star?.[1] ?? plain?.[1] ?? null;
  if (name) {
    try {
      name = decodeURIComponent(name.trim());
    } catch {
      /* keep raw */
    }
  } else {
    try {
      const last = new URL(url).pathname.split("/").pop() ?? "";
      name = last ? decodeURIComponent(last) : null;
    } catch {
      name = null;
    }
  }
  return name ? name.replace(/[\\/]/g, "_").slice(0, 200) : null;
}

export function isLikelyDownload(contentType: string | null, contentDisposition: string | null, url: string): boolean {
  if (/attachment/i.test(contentDisposition ?? "")) return true;
  const ct = (contentType ?? "").toLowerCase();
  if (!ct) return /\.[a-z0-9]{2,5}$/i.test(url.split("?")[0]) && !/\.(html?|php|aspx?|jsp)$/i.test(url.split("?")[0]);
  return !/^(text\/html|application\/xhtml|text\/plain|application\/json|image\/|video\/|audio\/)/.test(ct);
}

export function inspectDownload(body: Buffer, complete: boolean, opts: { url: string; contentType: string | null; contentDisposition: string | null; contentLength: number | null }): DownloadInspection {
  const fileName = fileNameFrom(opts.url, opts.contentDisposition);
  const ext = fileName && /\.([a-z0-9]{1,6})$/i.exec(fileName)?.[1]?.toLowerCase() || null;
  const kind = sniffFileKind(body);
  const expected = ext ? EXT_KIND[ext] : undefined;
  let mismatch: string | null = null;
  if (expected && !expected.includes(kind) && kind !== "unknown") {
    mismatch = `named ".${ext}" but the content is actually ${kind.replace(/_/g, " ")}`;
  }
  const mime = opts.contentType?.split(";")[0].trim().toLowerCase() ?? null;
  if (!mismatch && mime && EXECUTABLE_KINDS.has(kind) && /^(application\/pdf|image\/|video\/|audio\/|text\/)/.test(mime)) {
    mismatch = `the server says "${mime}" but the content is ${kind.replace(/_/g, " ")}`;
  }
  const doubleExtension = Boolean(fileName && /\.(pdf|docx?|xlsx?|jpe?g|png|txt|mp4|mp3)\.(exe|scr|bat|cmd|js|vbs|apk|jar|msi|ps1|com|pif)$/i.test(fileName));
  return {
    fileName,
    extension: ext,
    declaredMime: mime,
    detectedKind: kind,
    sizeDeclared: opts.contentLength,
    bytesInspected: body.length,
    sha256: complete ? createHash("sha256").update(body).digest("hex") : null,
    mismatch,
    executable: EXECUTABLE_KINDS.has(kind) || ["exe", "msi", "scr", "apk", "xapk", "jar", "dmg", "pkg", "bat", "cmd", "ps1", "vbs"].includes(ext ?? ""),
    doubleExtension,
    macroCapable: kind === "office_legacy" || ext === "docm" || ext === "xlsm",
  };
}
