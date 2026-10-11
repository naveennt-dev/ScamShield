import { cacheKey, cacheValue, checkWithService, decide, freshEntry, shouldCheck, warningParams } from "./lib.js";

// Session-only state (cleared when the browser closes): verdict cache (hashed keys), the sites the
// user chose to open anyway, and — per open tab — only the LAST page that passed the check (so
// "Go back to safety" can return there instead of to the dangerous page). No browsing history is
// kept. Never runs in incognito.

async function enabled() {
  const { enabled = true } = await chrome.storage.local.get("enabled");
  return enabled;
}

async function allowedThisSession(url) {
  const host = new URL(url).hostname;
  const { allowed = [] } = await chrome.storage.session.get("allowed");
  return allowed.includes(host);
}

async function setBadge(unprotected) {
  await chrome.action.setBadgeText({ text: unprotected ? "!" : "" });
  if (unprotected) await chrome.action.setBadgeBackgroundColor({ color: "#b45309" });
  await chrome.action.setTitle({ title: unprotected ? "ScamShield Link Guard: protection unavailable (the ScamShield service isn't answering)" : "ScamShield Link Guard" });
}

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`safe:${tabId}`));

chrome.webNavigation.onBeforeNavigate.addListener(async (d) => {
  if (!shouldCheck(d.url, d.frameId) || !(await enabled()) || (await allowedThisSession(d.url))) return;
  const key = await cacheKey(d.url);
  const cached = freshEntry((await chrome.storage.session.get(key))[key]);
  const result = cached ? cached.result : await checkWithService(d.url);
  if (!cached && result.ok) await chrome.storage.session.set({ [key]: { at: Date.now(), result: cacheValue(result) } });
  const decision = decide(result);
  await setBadge(Boolean(decision.unprotected));
  // A page that passed the check becomes this tab's "Go back to safety" destination.
  if (decision.action === "allow" && result.ok) await chrome.storage.session.set({ [`safe:${d.tabId}`]: d.url });
  if (decision.action === "warn") {
    await chrome.tabs.update(d.tabId, { url: chrome.runtime.getURL(`warning.html#${warningParams(d.url, result)}`) });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === "go-safe" && sender.tab && sender.url?.startsWith(chrome.runtime.getURL("warning.html"))) {
    (async () => {
      const k = `safe:${sender.tab.id}`;
      const safe = (await chrome.storage.session.get(k))[k];
      await chrome.tabs.update(sender.tab.id, { url: safe || "about:blank" });
      reply({ ok: true });
    })();
    return true;
  }
  // Only the extension's own warning page may grant a one-site, this-session exception.
  if (msg?.type === "allow-once" && sender.url?.startsWith(chrome.runtime.getURL("warning.html"))) {
    (async () => {
      const host = new URL(msg.url).hostname;
      const { allowed = [] } = await chrome.storage.session.get("allowed");
      if (!allowed.includes(host)) allowed.push(host);
      await chrome.storage.session.set({ allowed });
      reply({ ok: true });
    })();
    return true;
  }
  return false;
});
