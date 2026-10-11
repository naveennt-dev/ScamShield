import { parse as parseDomain } from "tldts";
import { isOfficialYouTubeHost, isYouTubeEmbed } from "./youtube";

/**
 * Static HTML inspection. A linear tag scanner (no regex backtracking over the page, no DOM, no
 * script execution) extracts what a phishing / malware / wrapper page needs to do its job: forms
 * that collect passwords or card numbers and where they post, embedded frames (including YouTube
 * players), external scripts, redirects, download links and fake prompts. Static inspection sees
 * what the server sent — not what scripts do later (that is the dynamic stage's job).
 */

export const MAX_HTML_BYTES = 512 * 1024;

interface Tag {
  name: string;
  attrs: Record<string, string>;
}

export interface PageForm {
  action: string | null;
  actionHost: string | null;
  method: string;
  password: boolean;
  card: boolean;
  otp: boolean;
  email: boolean;
  crossSite: boolean;
}

export interface PageFrame {
  src: string;
  host: string | null;
  youtubeEmbed: boolean;
  hidden: boolean;
  crossSite: boolean;
}

export interface PageInspection {
  title: string | null;
  forms: PageForm[];
  frames: PageFrame[];
  externalScriptHosts: string[];
  inlineScripts: number;
  metaRefresh: string | null;
  scriptRedirects: string[];
  downloadLinks: string[];
  fakePrompts: string[];
  obfuscatedScript: boolean;
  /** Script patterns that can read typed data, cookies or send data elsewhere (not proof of use). */
  exfilHints: string[];
  permissionApis: string[];
  mentionsYouTube: boolean;
  textSample: string;
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = 0;
  let count = 0;
  while (i < src.length && count < 64) {
    while (i < src.length && /[\s/]/.test(src[i])) i++;
    const start = i;
    while (i < src.length && !/[\s=/>]/.test(src[i])) i++;
    const name = src.slice(start, i).toLowerCase();
    if (!name) break;
    while (i < src.length && /\s/.test(src[i])) i++;
    let value = "";
    if (src[i] === "=") {
      i++;
      while (i < src.length && /\s/.test(src[i])) i++;
      const q = src[i];
      if (q === '"' || q === "'") {
        const end = src.indexOf(q, i + 1);
        value = src.slice(i + 1, end === -1 ? src.length : end);
        i = end === -1 ? src.length : end + 1;
      } else {
        const s = i;
        while (i < src.length && !/[\s>]/.test(src[i])) i++;
        value = src.slice(s, i);
      }
    }
    attrs[name] = value.replace(/&amp;/g, "&").slice(0, 2048);
    count++;
  }
  return attrs;
}

function scan(html: string, onTag: (t: Tag) => void, onScript: (body: string, t: Tag) => void, onText: (s: string) => void) {
  const lower = html.toLowerCase();
  let i = 0;
  let tags = 0;
  while (i < html.length && tags < 20_000) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      onText(html.slice(i));
      break;
    }
    if (lt > i) onText(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break;
    const inner = html.slice(lt + 1, gt);
    const m = /^(\/?[a-zA-Z][a-zA-Z0-9-]*)/.exec(inner); // "/form" = closing tag
    i = gt + 1;
    if (!m) continue;
    tags++;
    const tag: Tag = { name: m[1].toLowerCase(), attrs: parseAttrs(inner.slice(m[1].length)) };
    onTag(tag);
    if (!tag.name.startsWith("/") && (tag.name === "script" || tag.name === "style" || tag.name === "textarea")) {
      const close = lower.indexOf(`</${tag.name}`, i);
      const body = html.slice(i, close === -1 ? html.length : close);
      if (tag.name === "script") onScript(body, tag);
      i = close === -1 ? html.length : close;
    }
  }
}

const hostOf = (u: string | null) => {
  if (!u) return null;
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
};
const site = (h: string | null) => (h ? parseDomain(h).domain ?? h : null);
const resolveUrl = (v: string | undefined, base: string) => {
  if (!v) return null;
  try {
    return new URL(v.trim(), base).toString();
  } catch {
    return null;
  }
};

const FAKE_PROMPTS: Array<[RegExp, string]> = [
  [/\b(update|upgrade) (your )?(browser|chrome|flash|player|video player|codec)\b/i, "asks you to update your browser/player"],
  [/\b(your (device|phone|computer|pc|mac) (is|has been) (infected|hacked|compromised))\b/i, "claims your device is infected"],
  [/\bdownload (the )?(app|apk|file|player|update) (to|and) (continue|watch|play|view)\b/i, "asks you to download something to continue"],
  [/\b(allow|click allow) (notifications )?to (continue|verify|watch|prove you are not a robot)\b/i, "asks you to allow notifications to continue"],
  [/\b(verify|confirm) (your )?(account|identity|wallet)\b.{0,40}\b(to continue|to watch|immediately|within)\b/i, "asks you to verify your account to continue"],
  [/\b(enter|type) (your )?(otp|pin|cvv|password|seed phrase|recovery phrase)\b/i, "asks you to type a password/OTP/PIN"],
  [/\b(congratulations|you (have )?won)\b.{0,60}\b(claim|prize|reward|gift)\b/i, "prize/reward bait"],
];

export function inspectHtml(raw: Buffer | string, pageUrl: string): PageInspection {
  const html = (typeof raw === "string" ? raw : raw.toString("utf8")).slice(0, MAX_HTML_BYTES);
  const pageSite = site(hostOf(pageUrl));
  const out: PageInspection = {
    title: null,
    forms: [],
    frames: [],
    externalScriptHosts: [],
    inlineScripts: 0,
    metaRefresh: null,
    scriptRedirects: [],
    downloadLinks: [],
    fakePrompts: [],
    obfuscatedScript: false,
    exfilHints: [],
    permissionApis: [],
    mentionsYouTube: false,
    textSample: "",
  };
  let inTitle = false;
  let text = "";
  let currentForm: PageForm | null = null;
  const scriptHosts = new Set<string>();
  const hints = new Set<string>();
  const perms = new Set<string>();

  scan(
    html,
    (t) => {
      const a = t.attrs;
      switch (t.name) {
        case "title":
          inTitle = true;
          break;
        case "/title":
          inTitle = false;
          break;
        case "form": {
          const action = resolveUrl(a.action, pageUrl) ?? pageUrl;
          const ah = hostOf(action);
          currentForm = { action, actionHost: ah, method: (a.method ?? "get").toLowerCase(), password: false, card: false, otp: false, email: false, crossSite: Boolean(ah && pageSite && site(ah) !== pageSite) };
          out.forms.push(currentForm);
          break;
        }
        case "input": {
          const f = currentForm ?? (out.forms.length ? out.forms[out.forms.length - 1] : null);
          const desc = `${a.type ?? ""} ${a.name ?? ""} ${a.id ?? ""} ${a.placeholder ?? ""} ${a.autocomplete ?? ""}`.toLowerCase();
          const target = f ?? (() => {
            const orphan: PageForm = { action: null, actionHost: null, method: "script", password: false, card: false, otp: false, email: false, crossSite: false };
            out.forms.push(orphan);
            currentForm = orphan;
            return orphan;
          })();
          if (/\bpassword\b|passwd|\bpwd\b/.test(desc)) target.password = true;
          if (/cc-number|card ?number|cardnumber|\bcvv\b|\bcvc\b|cc-csc|expiry|cc-exp/.test(desc)) target.card = true;
          if (/\botp\b|one-time-code|verification code|\bpin\b/.test(desc)) target.otp = true;
          if (/\bemail\b|username/.test(desc)) target.email = true;
          break;
        }
        case "iframe":
        case "frame":
        case "embed":
        case "object": {
          const src = resolveUrl(a.src ?? a.data, pageUrl);
          if (!src) break;
          const h = hostOf(src);
          const style = (a.style ?? "").replace(/\s/g, "").toLowerCase();
          const hidden = a.hidden !== undefined || /display:none|visibility:hidden|opacity:0/.test(style) || a.width === "0" || a.height === "0" || a.width === "1" || a.height === "1";
          out.frames.push({ src, host: h, youtubeEmbed: isYouTubeEmbed(src), hidden, crossSite: Boolean(h && pageSite && site(h) !== pageSite) });
          break;
        }
        case "script": {
          const src = resolveUrl(a.src, pageUrl);
          const h = hostOf(src);
          if (h && site(h) !== pageSite) scriptHosts.add(h);
          break;
        }
        case "meta":
          if ((a["http-equiv"] ?? "").toLowerCase() === "refresh") {
            const m = /url\s*=\s*['"]?([^'"\s]+)/i.exec(a.content ?? "");
            if (m) out.metaRefresh = resolveUrl(m[1], pageUrl);
          }
          break;
        case "a": {
          const href = resolveUrl(a.href, pageUrl);
          if (href && (a.download !== undefined || /\.(apk|exe|msi|scr|bat|cmd|ps1|vbs|jar|dmg|pkg|app|iso|img|zip|rar|7z|xapk|apks)(\?|$)/i.test(href))) {
            if (out.downloadLinks.length < 20) out.downloadLinks.push(href);
          }
          break;
        }
      }
      if (t.name === "/form") currentForm = null;
    },
    (body, t) => {
      if (t.attrs.src) return;
      out.inlineScripts++;
      const s = body.slice(0, 200_000);
      // Script-driven redirects
      for (const m of s.matchAll(/(?:window\.|document\.|top\.|self\.)?location(?:\.href)?\s*=\s*['"]([^'"]{1,500})['"]|location\.(?:replace|assign)\(\s*['"]([^'"]{1,500})['"]/g)) {
        const u = resolveUrl(m[1] ?? m[2], pageUrl);
        if (u && out.scriptRedirects.length < 10) out.scriptRedirects.push(u);
      }
      // Obfuscation: very long encoded blobs or eval/unescape chains
      if (/eval\s*\(\s*(?:atob|unescape|decodeURIComponent|String\.fromCharCode)/.test(s) || /[A-Za-z0-9+/=]{2000,}/.test(s) || (s.match(/\\x[0-9a-f]{2}/gi)?.length ?? 0) > 200) out.obfuscatedScript = true;
      if (/document\.cookie/.test(s)) hints.add("reads cookies");
      if (/addEventListener\(\s*['"](keydown|keypress|keyup|input)['"]/.test(s) && /(fetch|XMLHttpRequest|sendBeacon|WebSocket)\b/.test(s)) hints.add("listens to typing and sends network requests");
      if (/navigator\.sendBeacon/.test(s)) hints.add("uses sendBeacon (background data upload)");
      if (/new WebSocket\(/.test(s)) hints.add("opens a WebSocket connection");
      if (/localStorage|sessionStorage/.test(s) && /(fetch|XMLHttpRequest|sendBeacon)\b/.test(s)) hints.add("reads browser storage and sends network requests");
      if (/navigator\.clipboard|execCommand\(\s*['"]copy/.test(s)) perms.add("clipboard");
      if (/getUserMedia|mediaDevices/.test(s)) perms.add("camera/microphone");
      if (/geolocation\./.test(s)) perms.add("location");
      if (/Notification\.requestPermission|pushManager\.subscribe/.test(s)) perms.add("notifications");
      if (/navigator\.credentials/.test(s)) perms.add("saved credentials");
    },
    (chunk) => {
      if (inTitle && out.title === null) out.title = chunk.trim().slice(0, 200) || null;
      if (text.length < 50_000) text += ` ${chunk}`;
    },
  );

  const plain = text.replace(/&nbsp;/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
  out.textSample = plain.slice(0, 2000);
  for (const [re, label] of FAKE_PROMPTS) if (re.test(plain)) out.fakePrompts.push(label);
  out.externalScriptHosts = [...scriptHosts].slice(0, 30);
  out.exfilHints = [...hints];
  out.permissionApis = [...perms];
  out.mentionsYouTube = /youtube/i.test(`${out.title ?? ""} ${plain.slice(0, 5000)}`) || out.frames.some((f) => f.youtubeEmbed) || [...scriptHosts].some((h) => isOfficialYouTubeHost(h));
  return out;
}
