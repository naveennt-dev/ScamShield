import { parse as parseDomain } from "tldts";

/**
 * YouTube relationship of a link / page. The outer website and an embedded YouTube player are
 * separate analysis targets: a legitimate video embedded on a malicious page does not make the
 * page safe, and a direct youtube.com link is not assumed to belong to any wrapper.
 */

export type YouTubeRelation =
  | "official" // a page on YouTube's own domains
  | "official_redirect" // YouTube's own "leaving YouTube" redirect to another site (wrapper)
  | "imitation" // not YouTube but uses YouTube's name/look in the address
  | "none";

const OFFICIAL = new Set(["youtube.com", "youtu.be", "youtube-nocookie.com", "ytimg.com", "googlevideo.com"]);

export function isOfficialYouTubeHost(hostname: string): boolean {
  const d = parseDomain(hostname).domain;
  return Boolean(d && OFFICIAL.has(d));
}

export interface YouTubeLinkInfo {
  relation: YouTubeRelation;
  videoId: string | null;
  /** For youtube.com/redirect?q=… : the external destination YouTube would send you to. */
  redirectTarget: string | null;
  detail: string | null;
}

export function classifyYouTubeLink(url: string): YouTubeLinkInfo {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { relation: "none", videoId: null, redirectTarget: null, detail: null };
  }
  const host = u.hostname.toLowerCase();
  if (isOfficialYouTubeHost(host)) {
    if (/^\/redirect\/?$/.test(u.pathname)) {
      const q = u.searchParams.get("q");
      return {
        relation: "official_redirect",
        videoId: null,
        redirectTarget: q,
        detail: q ? "A YouTube redirect link: it leaves YouTube for another website, which is analysed separately." : "A YouTube redirect link without a destination.",
      };
    }
    const id =
      (parseDomain(host).domain === "youtu.be" ? u.pathname.slice(1).split("/")[0] : null) ||
      u.searchParams.get("v") ||
      /^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{6,20})/.exec(u.pathname)?.[1] ||
      null;
    return { relation: "official", videoId: id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null, redirectTarget: null, detail: "An official YouTube address." };
  }
  const labels = (parseDomain(host).domainWithoutSuffix ?? "") + "." + (parseDomain(host).subdomain ?? "");
  if (/(you-?tube|youtub|y0utube|yout0be|ytube|youtu-be)/i.test(labels) || /youtube/i.test(u.pathname.split("/")[1] ?? "")) {
    return { relation: "imitation", videoId: null, redirectTarget: null, detail: `Uses YouTube's name but is not a YouTube domain (${host}).` };
  }
  return { relation: "none", videoId: null, redirectTarget: null, detail: null };
}

/** Classify an embedded player URL found inside a page. */
export function isYouTubeEmbed(src: string): boolean {
  try {
    const u = new URL(src);
    return isOfficialYouTubeHost(u.hostname) && /^\/embed\//.test(u.pathname);
  } catch {
    return false;
  }
}
