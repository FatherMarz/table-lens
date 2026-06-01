// Toolbar click toggles engagement on the active tab. Content script
// handles drawing the panel and the highlight overlays. Background also
// listens for engaged/disengaged messages so it can update the ON badge.

const engagedTabs = new Set();

function setBadge(tabId, on) {
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#00A3A3" }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: on ? "ON" : "" }).catch(() => {});
}

async function flashBadge(tabId, text, color) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  await chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  }, 1800);
}

async function tryEngage(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "TABLE_LENS_ENGAGE" });
    return true;
  } catch (_) {}

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    await chrome.tabs.sendMessage(tabId, { type: "TABLE_LENS_ENGAGE" });
    return true;
  } catch (err) {
    console.error("Table Lens: cannot inject into tab", tabId, err);
    return false;
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  const tabId = tab.id;
  const wasEngaged = engagedTabs.has(tabId);

  if (wasEngaged) {
    engagedTabs.delete(tabId);
    await chrome.tabs.sendMessage(tabId, { type: "TABLE_LENS_DISENGAGE" }).catch(() => {});
    setBadge(tabId, false);
  } else {
    const ok = await tryEngage(tabId);
    if (ok) {
      engagedTabs.add(tabId);
      setBadge(tabId, true);
    } else {
      await flashBadge(tabId, "✕", "#9B2C2C");
    }
  }
});

// Content script tells us when it disengages itself (click-outside, X button, Esc)
chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender?.tab?.id;
  if (!tabId) return;
  if (msg?.type === "TABLE_LENS_BG_ENGAGED") {
    engagedTabs.add(tabId);
    setBadge(tabId, true);
  } else if (msg?.type === "TABLE_LENS_BG_DISENGAGED") {
    engagedTabs.delete(tabId);
    setBadge(tabId, false);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => engagedTabs.delete(tabId));

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && engagedTabs.has(tabId)) {
    engagedTabs.delete(tabId);
    setBadge(tabId, false);
  }
});
