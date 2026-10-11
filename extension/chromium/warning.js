const p = new URLSearchParams(location.hash.slice(1));
const to = p.get("to") || "";
document.getElementById("title").textContent = `${p.get("label") || "High risk"}: this link looks dangerous`;
document.getElementById("host").textContent = p.get("host") || (() => { try { return new URL(to).hostname; } catch { return "this site"; } })();
let reasons = [];
try { reasons = JSON.parse(p.get("reasons") || "[]"); } catch {}
const ul = document.getElementById("reasons");
for (const r of reasons.slice(0, 3)) { const li = document.createElement("li"); li.textContent = r; ul.appendChild(li); }
// Back to the last page that passed the check (history.back() would return to the dangerous page).
document.getElementById("back").onclick = () => chrome.runtime.sendMessage({ type: "go-safe" });
document.getElementById("close").onclick = () => chrome.tabs.getCurrent((t) => t && chrome.tabs.remove(t.id));
document.getElementById("continue").onclick = () => {
  if (!/^https?:\/\//i.test(to)) return;
  chrome.runtime.sendMessage({ type: "allow-once", url: to }, () => location.replace(to));
};
