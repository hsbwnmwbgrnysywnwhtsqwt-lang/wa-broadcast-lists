'use strict';

// התוסף פועל רק ב-WhatsApp Web: שם פאנל הצד זמין והאייקון פעיל,
// ובכל שאר האתרים הפאנל כבוי והאייקון אפור.
const WA_PREFIX = 'https://web.whatsapp.com/';
const isWa = (url) => typeof url === 'string' && url.startsWith(WA_PREFIX);

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error(err));

// בלי הרשאת "tabs" – tab.url קיים רק לטאבים של web.whatsapp.com (בזכות host_permissions)
async function applyToTab(tabId, url) {
  if (isWa(url)) {
    await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
    await chrome.action.enable(tabId);
  } else {
    await chrome.sidePanel.setOptions({ tabId, enabled: false });
    await chrome.action.disable(tabId);
  }
}

async function applyToAllTabs() {
  await chrome.action.disable(); // ברירת מחדל לטאבים חדשים
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) => applyToTab(t.id, t.url).catch(() => {})));
}

chrome.runtime.onInstalled.addListener(() => { applyToAllTabs(); });
chrome.runtime.onStartup.addListener(() => { applyToAllTabs(); });

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'loading' || info.url) applyToTab(tabId, tab.url).catch(() => {});
});

// פאנלים פתוחים: כל פאנל מתחבר ב-port בשם "panel:<tabId>" ונשאר מחובר כל עוד הוא פתוח
const openPanels = new Map(); // tabId -> port

chrome.runtime.onConnect.addListener((port) => {
  const m = /^panel:(\d+)$/.exec(port.name);
  if (!m) return;
  const tabId = Number(m[1]);
  openPanels.set(tabId, port);
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === 'closeMe') closePanel(tabId).catch(() => {});
  });
  port.onDisconnect.addListener(() => {
    if (openPanels.get(tabId) === port) openPanels.delete(tabId);
  });
});

// sidePanel.close קיים רק בגרסאות חדשות של Chrome. אחרת: כיבוי והדלקה של הפאנל לטאב סוגרים אותו.
async function closePanel(tabId) {
  if (chrome.sidePanel.close) return chrome.sidePanel.close({ tabId });
  await chrome.sidePanel.setOptions({ tabId, enabled: false });
  await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
}

// הכפתור בתפריט של WhatsApp (content.js): פותח את הפאנל, ואם הוא כבר פתוח – סוגר אותו.
// Chrome מאפשר sidePanel.open רק בתגובה ללחיצה, ולכן קוראים לו מיד – בלי await לפני.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'togglePanel' || !sender.tab || !isWa(sender.tab.url)) return false;
  const tabId = sender.tab.id;

  const port = openPanels.get(tabId);
  if (port) {
    // הפאנל סוגר את עצמו (ושואל קודם אם יש שליחה/סריקה באמצע)
    port.postMessage({ type: 'close' });
    sendResponse({ ok: true, closed: true });
    return false;
  }

  chrome.sidePanel
    .open({ tabId })
    .then(() => sendResponse({ ok: true, opened: true }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});
