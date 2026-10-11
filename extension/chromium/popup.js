const box = document.getElementById("enabled");
chrome.storage.local.get("enabled").then(({ enabled = true }) => { box.checked = enabled; });
box.onchange = () => chrome.storage.local.set({ enabled: box.checked });
fetch("http://127.0.0.1:3000/api/v1/health", { signal: AbortSignal.timeout(2000) })
  .then((r) => r.json())
  .then((j) => { document.getElementById("status").textContent = j?.data?.status === "ok" || j?.data?.status === "degraded" ? "Protection is on: the ScamShield service is running." : "The ScamShield service isn't healthy — links aren't being checked."; })
  .catch(() => { document.getElementById("status").textContent = "The ScamShield service isn't running — links aren't being checked. Start it with scripts/scamshield.sh start."; });
