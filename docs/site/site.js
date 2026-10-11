// Renders platform cards from releases.json. A download button is shown ONLY for a released asset
// with an https URL on this repository's GitHub Releases and a SHA-256 checksum.
(async () => {
  const $ = (id) => document.getElementById(id);
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
  const releasedAsset = (p) => p.status === "released" && p.asset && /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//.test(p.asset.url || "") && /^[0-9a-f]{64}$/.test(p.asset.sha256 || "");
  const storeLink = (p) => p.status === "released" && p.store && /^https:\/\/(play\.google\.com|apps\.apple\.com|chromewebstore\.google\.com)\//.test(p.store.url || "");

  function card(p, data) {
    const c = el("article", `card status-${p.status}`);
    const head = el("div", "card-head");
    head.append(el("h3", null, p.name), el("span", `pill pill-${p.status}`, PILL[p.status] || p.status));
    c.append(head);
    c.append(el("p", "status", p.statusText));
    const dl = el("dl");
    for (const [k, v] of [["Requirements", p.requirements], ["Package", p.package], ["Version", data.version], ["Released", data.releaseDate]]) {
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
  $("release-line").textContent = data.version
    ? `Latest release: ${data.version}${data.releaseDate ? ` (${data.releaseDate})` : ""}.`
    : "No release has been published yet — nothing can be downloaded today. Each platform below shows its real status.";

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
