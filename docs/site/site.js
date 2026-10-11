// Renders platform cards from releases.json. A download button is shown ONLY for a released asset
// with an https URL on this repository's GitHub Releases and a SHA-256 checksum.
(async () => {
  const $ = (id) => document.getElementById(id);

  // Mobile navigation: toggle the menu; close it after choosing a section.
  const toggle = $("menu-toggle"), links = $("nav-links");
  if (toggle && links) {
    toggle.addEventListener("click", () => {
      const open = links.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    links.addEventListener("click", (e) => {
      if (e.target.closest("a")) { links.classList.remove("open"); toggle.setAttribute("aria-expanded", "false"); }
    });
  }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  function detect() {
    const ua = navigator.userAgent || "";
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    if (/Android/i.test(ua)) return "android";
    if (/iPhone|iPad|iPod/i.test(ua) || (platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
    if (/Mac/i.test(platform) || /Mac OS X/i.test(ua)) return "macos";
    if (/Win/i.test(platform) || /Windows/i.test(ua)) return "windows";
    if (/Linux/i.test(platform) || /Linux/i.test(ua)) return "linux";
    return null;
  }

  const PILL = { released: "Available", "built-not-released": "Coming soon", "in-testing": "Testing", planned: "Planned" };
  // Downloads come only from this repository's GitHub Releases, with a SHA-256 checksum.
  const REPO = "naveennt-dev/ScamShield";
  const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
  const releasedAsset = (p) => p.status === "released" && p.asset && (p.asset.url || "").startsWith(DOWNLOAD_PREFIX) && /^[0-9a-f]{64}$/.test(p.asset.sha256 || "");
  // Asset names written by scripts/release/package-release.sh, which only names files that passed
  // its signing/notarization checks. Anything else in a release is ignored.
  const ASSET_NAME = { macos: /^ScamShield-(\d+\.\d+\.\d+)-macos-arm64\.dmg$/, android: /^ScamShield-(\d+\.\d+\.\d+)-android\.apk$/ };
  const SIGNING = {
    macos: "Developer ID signed and notarized by Apple — checked before upload. Verify the SHA-256 after downloading.",
    android: "Signed with the ScamShield release key — checked before upload. Verify the SHA-256 after downloading.",
  };

  /** Newest published (non-draft) release from GitHub, preferring a full release over a pre-release. */
  async function latestRelease() {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`, { headers: { Accept: "application/vnd.github+json" } });
    if (!r.ok) throw new Error(`GitHub API ${r.status}`);
    const published = (await r.json()).filter((x) => x && !x.draft);
    return published.find((x) => !x.prerelease) || published[0] || null;
  }

  /** Turns a platform card "released" only for an uploaded asset with the expected name, this
      repository's download URL for the same tag, and a GitHub-computed SHA-256 digest. */
  function applyRelease(data, release) {
    const tag = String(release.tag_name || "");
    const version = tag.replace(/^v/, "");
    let found = 0;
    for (const p of data.platforms) {
      const re = ASSET_NAME[p.id];
      if (!re) continue;
      const a = (release.assets || []).find((x) => { const m = re.exec(x.name || ""); return m && m[1] === version; });
      if (!a || a.state !== "uploaded" || !/^sha256:[0-9a-f]{64}$/.test(a.digest || "")) continue;
      if (a.browser_download_url !== `${DOWNLOAD_PREFIX}${tag}/${a.name}`) continue;
      p.status = "released";
      p.statusText = release.prerelease ? "Pre-release — for testing." : "Available now.";
      p.asset = { url: a.browser_download_url, sha256: a.digest.slice(7), signing: SIGNING[p.id] };
      found++;
    }
    if (found) { data.version = version; data.releaseDate = String(release.published_at || "").slice(0, 10); data.releaseUrl = release.html_url; data.prerelease = !!release.prerelease; }
    return found;
  }
  const storeLink = (p) => p.status === "released" && p.store && /^https:\/\/(play\.google\.com|apps\.apple\.com|chromewebstore\.google\.com)\//.test(p.store.url || "");

  function card(p, data) {
    const c = el("article", `card status-${p.status}`);
    const head = el("div", "card-head");
    head.append(el("h3", null, p.name), el("span", `pill pill-${p.status}`, PILL[p.status] || p.status));
    c.append(head);
    c.append(el("p", "status", p.statusText));
    const dl = el("dl");
    const own = releasedAsset(p); // version/date only on cards that really have a release asset
    for (const [k, v] of [["Requirements", p.requirements], ["Package", p.package], ["Version", own ? data.version : null], ["Released", own ? data.releaseDate : null]]) {
      if (v && v !== "—") dl.append(el("dt", null, k), el("dd", null, v)); // only real values
    }
    if (dl.childElementCount) c.append(dl);
    if (releasedAsset(p)) {
      const a = el("a", "button", `Download for ${p.name}`);
      a.href = p.asset.url; a.setAttribute("download", "");
      c.append(a, el("p", "sha", `SHA-256: ${p.asset.sha256}`));
      if (p.asset.signing) c.append(el("p", "fine", p.asset.signing));
    } else if (storeLink(p)) {
      const a = el("a", "button", p.store.label || `Get it for ${p.name}`);
      a.href = p.store.url; a.rel = "noopener";
      c.append(a);
    } else {
      const b = el("button", "button", "Not available yet");
      b.disabled = true; b.setAttribute("aria-disabled", "true");
      c.append(b);
    }
    if (p.guide) { const g = el("a", "guide", "Installation guide"); g.href = p.guide; c.append(g); }
    return c;
  }

  let data;
  try {
    const r = await fetch("releases.json", { cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    data = await r.json();
  } catch {
    $("release-line").textContent = "Release information could not be loaded. See the project's GitHub Releases page.";
    return;
  }
  // Real published assets from GitHub Releases (releases.json only describes status/requirements).
  let ghError = false, found = 0, release = null;
  try { release = await latestRelease(); if (release) found = applyRelease(data, release); } catch { ghError = true; }
  const line = $("release-line");
  const releasesPage = `https://github.com/${REPO}/releases`;
  const link = (text, href) => { const a = el("a", null, text); a.href = href; return a; };
  if (found) {
    const page = (data.releaseUrl || "").startsWith(`https://github.com/${REPO}/releases/tag/`) ? data.releaseUrl : releasesPage;
    line.replaceChildren(`${data.prerelease ? "Latest pre-release" : "Latest release"}: ScamShield ${data.version}${data.releaseDate ? ` (${data.releaseDate})` : ""} · `, link("release notes", page));
  } else if (release) {
    line.replaceChildren(`ScamShield ${String(release.tag_name || "").replace(/^v/, "")} is on GitHub, but no verified download for these platforms is attached yet. `, link("Open the Releases page", releasesPage), ".");
  } else if (ghError) {
    line.replaceChildren("Couldn't check GitHub for releases right now. ", link("Open the Releases page", releasesPage), " to see what's available.");
  } else {
    line.textContent = "No release has been published yet — nothing can be downloaded today. Each platform below shows its real status.";
  }

  const picker = $("picker");
  for (const p of data.platforms) { const o = el("option", null, p.name); o.value = p.id; picker.append(o); }
  const render = (id) => { $("cards").replaceChildren(...data.platforms.filter((p) => !id || p.id === id).map((p) => card(p, data))); };
  const all = el("option", null, "All platforms"); all.value = ""; picker.prepend(all);

  const mine = detect();
  const rec = mine && data.platforms.find((p) => p.id === mine);
  if (rec) { $("recommended").hidden = false; $("rec-card").replaceChildren(card(rec, data)); }
  picker.value = "";
  render("");
  picker.addEventListener("change", () => render(picker.value));
})();
