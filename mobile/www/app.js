// ScamShield mobile UI. All analysis runs in ScamShieldEngine (bundled, on-device, local-only).
// Every value from a scan is inserted with textContent — message content can never become HTML.
(() => {
  const E = window.ScamShieldEngine;
  const $ = (id) => document.getElementById(id);
  let mode = "message";

  function setMode(next) {
    mode = next;
    $("tab-message").setAttribute("aria-selected", String(next === "message"));
    $("tab-link").setAttribute("aria-selected", String(next === "link"));
    $("panel").setAttribute("aria-labelledby", `tab-${next}`);
    $("input").hidden = next !== "message";
    $("link").hidden = next !== "link";
    $("input-label").textContent = next === "message" ? "Paste or share the message you received" : "Paste the link (it is not opened)";
    $("result").hidden = true;
    (next === "message" ? $("input") : $("link")).focus();
  }

  function list(el, items) {
    el.replaceChildren(...items.map((t) => { const li = document.createElement("li"); li.textContent = String(t); return li; }));
  }

  function show({ tone, headline, score, category, reasons, actions, colour }) {
    const card = $("result");
    card.className = `card ${tone}`;
    $("r-headline").textContent = headline;
    $("r-score").textContent = score;
    $("r-category").textContent = category || "";
    $("r-category").hidden = !category;
    $("r-why-title").hidden = reasons.length === 0;
    list($("r-reasons"), reasons);
    list($("r-actions"), actions);
    $("r-actions-box").hidden = actions.length === 0;
    $("r-colour").textContent = colour || "";
    card.hidden = false;
    card.focus();
  }

  const toneOf = (level) => (level === "safe" ? "safe" : level === "suspicious" ? "caution" : "danger");

  function fromMessage(r) {
    if (r.assessment && r.assessment.status === "insufficient") {
      return { tone: "grey", headline: "Unable to assess", score: "Not a safe result — part of the check didn't run.", category: "", reasons: r.assessment.reasons || [], actions: ["Check the message yourself, or try again."], colour: r.decision && r.decision.why };
    }
    const label = { safe: "No scam signs found", suspicious: "Suspicious", high: "High risk", critical: "High-risk scam" }[r.riskLevel] || r.riskLevel;
    return { tone: toneOf(r.riskLevel), headline: label, score: `Risk score ${r.riskScore} / 100`, category: r.riskLevel === "safe" ? "" : r.categoryLabel,
      reasons: (r.reasons || []).slice(0, 6), actions: (r.recommendedActions || []).slice(0, 4), colour: r.decision && r.decision.why };
  }

  function fromLink(r) {
    if (!r.ok) return { tone: "grey", headline: "Couldn't check this link", score: r.summary || "That doesn't look like a web address.", category: "", reasons: [], actions: [], colour: "" };
    const tone = { no_known_threat: "safe", suspicious: "caution", high_risk: "danger", malicious: "danger", inconclusive: "grey" }[r.verdict] || "grey";
    const reasons = (r.evidence || []).filter((e) => e.severity !== "low").slice(0, 6).map((e) => e.detail);
    return { tone, headline: r.verdictLabel, score: `${r.displayHostname || r.hostname || ""}${r.analysis ? ` · risk score ${r.analysis.riskScore} / 100` : ""}`,
      category: r.summary, reasons, actions: r.recommendedAction ? [r.recommendedAction] : [], colour: r.analysis && r.analysis.decision && r.analysis.decision.why };
  }

  async function check() {
    const value = (mode === "message" ? $("input").value : $("link").value).trim();
    if (!value) { (mode === "message" ? $("input") : $("link")).focus(); return; }
    const btn = $("check");
    btn.disabled = true; btn.textContent = "Checking…";
    try {
      show(mode === "message" ? fromMessage(await E.analyzeMessage(value.slice(0, 10000), "screen")) : fromLink(await E.analyzeLink(value.slice(0, 4096))));
    } catch (e) {
      // Never a silent "safe": a failure is shown as such.
      show({ tone: "grey", headline: "Unable to assess", score: "The check failed on this device — this is not a safe result.", category: "", reasons: [String(e && e.message || e).slice(0, 200)], actions: [], colour: "" });
    } finally {
      btn.disabled = false; btn.textContent = "Check";
    }
  }

  // Text shared to ScamShield from another app (Android share sheet) — filled in, never auto-sent anywhere.
  window.scamShieldReceiveShared = (text) => {
    if (typeof text !== "string" || !text.trim()) return;
    const t = text.trim();
    const onlyLink = /^https?:\/\/\S+$/i.test(t);
    setMode(onlyLink ? "link" : "message");
    (onlyLink ? $("link") : $("input")).value = t.slice(0, 10000);
    check();
  };

  $("tab-message").addEventListener("click", () => setMode("message"));
  $("tab-link").addEventListener("click", () => setMode("link"));
  $("check").addEventListener("click", check);
  $("clear").addEventListener("click", () => { $("input").value = ""; $("link").value = ""; $("result").hidden = true; });
  $("link").addEventListener("keydown", (e) => { if (e.key === "Enter") check(); });
  $("engine-info").textContent = E ? `On-device engine · model ${E.engineInfo.model} ${E.engineInfo.version} · no data leaves this phone` : "Engine failed to load";
  if (!E) $("check").disabled = true;
})();
