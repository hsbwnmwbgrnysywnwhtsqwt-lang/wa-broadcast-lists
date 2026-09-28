(() => {
  'use strict';

  if (window.__waGroupsHelper) return;
  window.__waGroupsHelper = true;

  // ------------------------------------------------------------------
  // סלקטורים של WhatsApp Web.
  // WhatsApp משנה את מבנה הדף מעת לעת – אם משהו מפסיק לעבוד, מעדכנים כאן בלבד.
  // ------------------------------------------------------------------
  const SELECTORS = {
    // החלון שנפתח ב-/send?text=... ("שלח אל" / בחירת צ'אטים)
    picker: ['div[role="dialog"]', '[data-animate-modal-popup="true"]'],
    pickerSearch: [
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'input[type="text"]',
    ],
    row: '[role="listitem"], [role="row"], [role="option"], [role="button"], [role="checkbox"]',
    // שורות לסריקה – רק שורות שלמות, לא כפתורים קטנים בתוכן
    scanRow: '[role="listitem"], [role="row"], [role="option"]',
    checkState: '[aria-checked], input[type="checkbox"]',
    // החץ הירוק שמופיע בחלון אחרי שמסמנים צ'אטים (רק מזהים לחיצה של המשתמש – לא לוחצים)
    sendButton: [
      '[data-icon="send"]',
      '[data-icon="wds-ic-send-filled"]',
      '[data-icon*="send"]',
      '[aria-label="Send"]',
      '[aria-label="שליחה"]',
      '[aria-label="שלח"]',
    ],
    chatList: '#pane-side',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function queryFirst(list, root = document) {
    for (const sel of list) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  async function waitFor(fn, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = fn();
      if (result) return result;
      await sleep(150);
    }
    return null;
  }

  function findPicker() {
    for (const sel of SELECTORS.picker) {
      for (const el of document.querySelectorAll(sel)) {
        if (queryFirst(SELECTORS.pickerSearch, el)) return el;
      }
    }
    return null;
  }

  function findTitle(root, name) {
    return root.querySelector(`span[title="${CSS.escape(name)}"]`);
  }

  // true / false, או null אם אין בשורה אינדיקציה לבחירה
  function isChecked(row) {
    const el = row.matches(SELECTORS.checkState) ? row : row.querySelector(SELECTORS.checkState);
    if (el) return el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true';
    if (row.hasAttribute('aria-selected')) return row.getAttribute('aria-selected') === 'true';
    return null;
  }

  function typeInto(el, text) {
    el.focus();
    if (el instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      if (text) document.execCommand('insertText', false, text);
    }
  }

  // ------------------------------------------------------------------
  // סימון צ'אטים ושליחה
  // ------------------------------------------------------------------

  // מסמן צ'אט אחד בחלון. מחזיר 'selected' / 'unverified' / 'not-found' / 'failed'
  async function selectInPicker(picker, name) {
    const search = queryFirst(SELECTORS.pickerSearch, picker);
    if (search) typeInto(search, name);

    const title = await waitFor(() => findTitle(picker, name), 4000);
    if (!title) return 'not-found';

    const row = title.closest(SELECTORS.row) || title;
    if (isChecked(row) === true) return 'selected';

    row.click();
    await sleep(250);

    // WhatsApp עשוי לצייר את השורה מחדש אחרי הלחיצה – בודקים את השורה העדכנית
    const currentRow = () => {
      const t = findTitle(picker, name);
      return (t && (t.closest(SELECTORS.row) || t)) || row;
    };
    let state = isChecked(currentRow());
    if (state === false) {
      // חלק מהגרסאות מגיבות ל-mousedown ולא ל-click
      const r = currentRow();
      for (const type of ['mousedown', 'mouseup']) {
        r.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      await sleep(250);
      state = isChecked(currentRow());
    }
    if (state === true) return 'selected';
    return state === null ? 'unverified' : 'failed';
  }

  function findSendButton(picker) {
    // מחפשים רק בתוך חלון הבחירה – לא בכפתור השליחה של חלון השיחה
    const roots = [picker, ...document.querySelectorAll(SELECTORS.picker.join(','))];
    for (const root of roots) {
      const icon = queryFirst(SELECTORS.sendButton, root);
      if (icon) return icon.closest('button, [role="button"]') || icon;
    }
    return null;
  }

  let cancelWaiting = null;

  // ה-Extension לא לוחץ שלח. מחכים שהמשתמש ילחץ על החץ הירוק והחלון ייסגר.
  // מחזיר 'sent' / 'closed' (נסגר בלי לחיצה על שלח) / 'cancelled' / 'timeout'
  function waitForUserSend(picker, timeoutMs = 10 * 60 * 1000) {
    return new Promise((resolve) => {
      let clicked = false;
      const onClick = (e) => {
        const btn = findSendButton(picker);
        if (btn && btn.contains(e.target)) clicked = true;
      };
      document.addEventListener('click', onClick, true);

      const start = Date.now();
      const finish = (result) => {
        clearInterval(timer);
        document.removeEventListener('click', onClick, true);
        cancelWaiting = null;
        resolve(result);
      };
      const timer = setInterval(() => {
        if (!document.contains(picker) || !findPicker()) finish(clicked ? 'sent' : 'closed');
        else if (Date.now() - start > timeoutMs) finish('timeout');
      }, 300);
      cancelWaiting = () => finish('cancelled');
    });
  }

  async function selectAndWait(names) {
    const picker = await waitFor(findPicker, 30000);
    if (!picker) {
      throw new Error('חלון בחירת הצ\'אטים לא נפתח. ודא שאתה מחובר ל-WhatsApp Web.');
    }
    await sleep(400);

    const results = [];
    for (const name of names) {
      results.push({ name, status: await selectInPicker(picker, name) });
    }

    const search = queryFirst(SELECTORS.pickerSearch, picker);
    if (search) typeInto(search, '');

    const anySelected = results.some((r) => r.status === 'selected' || r.status === 'unverified');
    const outcome = anySelected ? await waitForUserSend(picker) : 'none';
    return { results, outcome };
  }

  // ------------------------------------------------------------------
  // שליחת תמונות וסרטונים – נמען אחד בכל פעם.
  // חלון "שלח אל" של WhatsApp תומך רק בטקסט, אז כאן פותחים את השיחה של כל נמען,
  // מצרפים את הקבצים, כותבים את ההודעה ככיתוב – והמשתמש לוחץ שלח בעצמו.
  // ------------------------------------------------------------------
  const CHAT = {
    // תיבת החיפוש של רשימת הצ'אטים – בעיצוב החדש של WhatsApp היא לא בהכרח בתוך #side,
    // אז מחפשים לפי התווית ("Search or start a new chat" / "חיפוש"), ואחר כך לפי מיקום.
    searchLabel: /search|חיפוש|חפש|new chat|צ'אט חדש|צ׳אט חדש/i,
    searchBox: [
      '#side div[contenteditable="true"][role="textbox"]',
      '#side input[type="text"]',
      '#side input',
    ],
    composeBox: [
      'footer div[contenteditable="true"][role="textbox"]',
      'footer div[contenteditable="true"]',
    ],
    chatRow: '[role="listitem"], [role="row"], [role="gridcell"], [role="button"]',
    // הודעות יוצאות (שנשלחו ממני) – ה-data-id שלהן מתחיל ב-"true_"
    outgoing: '[data-id^="true_"]',
    // כפתור התפריט של הודעה, ופריט "העברה" בתפריט
    messageMenu: [
      '[data-icon="down-context"]',
      '[data-icon="ic-chevron-down-menu"]',
      '[data-icon*="chevron-down"]',
      '[data-icon*="down-context"]',
      '[aria-label="Context menu"]',
      '[aria-label="תפריט הקשר"]',
    ],
    forwardLabel: /^(forward|העברה|העבר|העברת הודעה)$/i,
    forwardIcon: ['[data-icon="forward"]', '[data-icon="forward-refreshed"]', '[data-icon*="forward"]'],
  };

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // השיחה הפתוחה (החלק הימני/המרכזי של WhatsApp)
  function getMain() {
    const main = document.querySelector('#main');
    if (main) return main;
    const compose = [...document.querySelectorAll(CHAT.composeBox.join(','))]
      .find((el) => !el.closest(SELECTORS.picker.join(',')));
    let el = compose;
    while (el && !(el.querySelector && el.querySelector('header'))) el = el.parentElement;
    return el || null;
  }

  function findCompose() {
    const main = getMain();
    return main ? queryFirst(CHAT.composeBox, main) : null;
  }

  function inComposeFooter(el) {
    const compose = findCompose();
    const footer = compose && compose.closest('footer');
    return !!footer && footer.contains(el);
  }

  function findSearchBox() {
    const main = getMain();
    const candidates = [...document.querySelectorAll('input, div[contenteditable="true"]')].filter((el) =>
      isVisible(el)
      && !(main && main.contains(el))
      && !el.closest(`${SELECTORS.picker.join(',')}, footer, #wa-bl-scan-overlay`));
    const label = (el) => ['aria-label', 'placeholder', 'aria-placeholder', 'title', 'data-tab']
      .map((a) => el.getAttribute(a) || '').join(' ');
    return candidates.find((el) => CHAT.searchLabel.test(label(el)))
      || queryFirst(CHAT.searchBox)
      || candidates.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]
      || null;
  }

  let attachments = null; // { id, files: File[] } – נשלחים פעם אחת מהפאנל ונשמרים כאן

  function base64ToFile({ name, type, data }) {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type });
  }

  // כותרת צ'אט ברשימת הצ'אטים / תוצאות החיפוש (לא בשיחה הפתוחה ולא בחלונות)
  function findChatTitle(name) {
    const main = getMain();
    for (const span of document.querySelectorAll(`span[title="${CSS.escape(name)}"]`)) {
      if (!(main && main.contains(span)) && !span.closest(SELECTORS.picker.join(','))) return span;
    }
    return null;
  }

  function isChatOpen(name) {
    const main = getMain();
    return !!main && [...main.querySelectorAll('header span')]
      .some((s) => (s.getAttribute('title') || s.textContent || '').trim() === name);
  }

  function clickRow(el) {
    const target = el.closest(CHAT.chatRow) || el;
    for (const type of ['mousedown', 'mouseup', 'click']) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  // פותח את השיחה עם הנמען (דרך החיפוש של WhatsApp). מחזיר את תיבת הכתיבה, או null אם לא נמצא.
  async function openChat(name) {
    if (isChatOpen(name) && findCompose()) return findCompose();
    let title = findChatTitle(name);
    let search = null;
    if (!title) {
      // אחרי טעינה מחדש WhatsApp עדיין מצייר את הממשק ("Loading your chats") – מחכים לתיבת החיפוש
      search = await waitFor(findSearchBox, 30000);
      if (!search) throw new Error('לא נמצאה תיבת החיפוש של WhatsApp. ודא שאתה מחובר.');
      typeInto(search, name);
      title = await waitFor(() => findChatTitle(name), 5000);
    }
    let compose = null;
    if (title) {
      clickRow(title);
      compose = await waitFor(() => isChatOpen(name) && findCompose(), 6000);
    }
    if (search) typeInto(search, '');
    return compose;
  }

  // הדבקה דרך אירוע paste שומרת על שורות חדשות בלי ללחוץ Enter (שהיה שולח).
  // WhatsApp מכניס את הטקסט רק אחרי רגע – לכן מחכים לו, ומכניסים בעצמנו רק אם הוא לא טיפל בהדבקה בכלל
  // (אחרת הטקסט היה מופיע פעמיים).
  async function pasteText(el, text) {
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const handled = !el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    const appeared = await waitFor(() => el.textContent.trim(), handled ? 1500 : 300);
    if (!appeared) {
      el.focus();
      document.execCommand('insertText', false, text);
    }
  }

  // כפתור השליחה של חלון התצוגה המקדימה של המדיה (לא זה של תיבת הכתיבה הרגילה)
  function findMediaSend() {
    for (const icon of document.querySelectorAll(SELECTORS.sendButton.join(','))) {
      if (icon.closest('#side, #wa-bl-nav-item, #wa-bl-float') || inComposeFooter(icon)) continue;
      return icon.closest('button, [role="button"]') || icon;
    }
    return null;
  }

  function findCaptionBox(sendBtn) {
    let el = sendBtn;
    for (let i = 0; i < 10 && el; i++) {
      el = el.parentElement;
      const box = el && [...el.querySelectorAll('div[contenteditable="true"]')]
        .find((b) => !b.closest('#side') && !inComposeFooter(b));
      if (box) return box;
    }
    return null;
  }

  function makeTransfer(files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    return dt;
  }

  // מצרף את הקבצים כמו הדבקה (Cmd+V); אם WhatsApp לא הגיב – כמו גרירה לחלון השיחה
  async function attachFiles(compose, files) {
    compose.focus();
    compose.dispatchEvent(new ClipboardEvent('paste', { clipboardData: makeTransfer(files), bubbles: true, cancelable: true }));
    const btn = await waitFor(findMediaSend, 6000);
    if (btn) return btn;

    const dt = makeTransfer(files);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      compose.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
    return waitFor(findMediaSend, 6000);
  }

  // מחכה שהמשתמש ילחץ שלח (או Enter בכיתוב) ושהחלון ייסגר.
  // מחזיר 'sent' / 'closed' (נסגר בלי שליחה) / 'cancelled' / 'timeout'
  function waitForMediaSend(captionBox, timeoutMs = 10 * 60 * 1000) {
    return new Promise((resolve) => {
      let sent = false;
      const onClick = (e) => {
        const btn = findMediaSend();
        if (btn && btn.contains(e.target)) sent = true;
      };
      const onKey = (e) => {
        if (e.key === 'Enter' && !e.shiftKey && captionBox && captionBox.contains(e.target)) sent = true;
      };
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);

      const start = Date.now();
      const finish = (result) => {
        clearInterval(timer);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKey, true);
        cancelWaiting = null;
        resolve(result);
      };
      const timer = setInterval(() => {
        if (!findMediaSend()) finish(sent ? 'sent' : 'closed');
        else if (Date.now() - start > timeoutMs) finish('timeout');
      }, 300);
      cancelWaiting = () => finish('cancelled');
    });
  }

  // מחזיר status: 'sent' / 'not-found' / 'failed' / 'closed' / 'cancelled' / 'timeout' / 'need-attachments'
  async function sendMedia(name, caption, attachId) {
    if (!attachments || attachments.id !== attachId) return { status: 'need-attachments' };

    const compose = await openChat(name);
    if (!compose) return { status: 'not-found' };
    typeInto(compose, ''); // טיוטה שנשארה בשיחה הייתה נשלחת יחד עם הקבצים
    const before = outgoingIds();

    const sendBtn = await attachFiles(compose, attachments.files);
    if (!sendBtn) return { status: 'failed' };
    await sleep(300);

    const captionBox = findCaptionBox(sendBtn);
    if (caption && captionBox) await pasteText(captionBox, caption);

    const status = await waitForMediaSend(captionBox);
    if (status !== 'sent') return { status };
    // ההודעה שנוצרה עכשיו – כדי להעביר אותה לשאר הנמענים
    const messageId = await waitFor(() => [...outgoingIds()].find((id) => !before.has(id)), 8000);
    return { status, messageId: messageId || null };
  }

  function outgoingIds() {
    const main = getMain();
    return new Set(main ? [...main.querySelectorAll(CHAT.outgoing)].map((el) => el.getAttribute('data-id')) : []);
  }

  // ------------------------------------------------------------------
  // העברה (Forward) של ההודעה שנשלחה – 5 נמענים בכל פעם.
  // הודעה שכתבת בעצמך ומעבירים לא מסומנת "הועברה" אצל הנמענים.
  // ------------------------------------------------------------------
  function hover(el) {
    for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  function pressable(el) {
    return el.closest('button, [role="button"]') || el;
  }

  async function openForwardDialog(msgEl) {
    const row = msgEl.closest('[role="row"]') || msgEl;

    // 1. כפתור העברה מהיר שמופיע ליד הודעות מדיה במעבר עכבר
    hover(row);
    hover(msgEl);
    await sleep(300);
    const quick = queryFirst(CHAT.forwardIcon, row);
    if (quick) {
      pressable(quick).click();
      const picker = await waitFor(findPicker, 3000);
      if (picker) return picker;
    }

    // 2. תפריט ההודעה ← "העברה"
    hover(msgEl);
    await sleep(300);
    const menuBtn = queryFirst(CHAT.messageMenu, row);
    if (!menuBtn) return null;
    pressable(menuBtn).click();
    const item = await waitFor(() => [...document.querySelectorAll('li, [role="menuitem"], [role="button"]')]
      .find((el) => isVisible(el) && CHAT.forwardLabel.test((el.textContent || '').trim())), 3000);
    if (!item) return null;
    pressable(item).click();
    const picker = await waitFor(findPicker, 3000);
    if (picker) return picker;

    // 3. מצב בחירת הודעות: ההודעה כבר מסומנת – לוחצים על כפתור ההעברה בתחתית
    const main = getMain();
    const fwd = main && [...main.querySelectorAll(CHAT.forwardIcon.join(','))].filter(isVisible).pop();
    if (!fwd) return null;
    pressable(fwd).click();
    return waitFor(findPicker, 3000);
  }

  // מחזיר { results, outcome } כמו selectAndWait, או { unavailable: true } אם אי אפשר להעביר
  async function forwardAndWait(sourceChat, messageId, names) {
    const compose = await openChat(sourceChat);
    if (!compose) return { unavailable: true, reason: 'source-chat' };
    const main = getMain();
    const msgEl = await waitFor(() => main.querySelector(`[data-id="${CSS.escape(messageId)}"]`), 4000);
    if (!msgEl) return { unavailable: true, reason: 'message' };
    msgEl.scrollIntoView({ block: 'center' });
    await sleep(300);

    const picker = await openForwardDialog(msgEl);
    if (!picker) return { unavailable: true, reason: 'forward-dialog' };
    await sleep(400);

    const results = [];
    for (const name of names) {
      results.push({ name, status: await selectInPicker(picker, name) });
    }
    const search = queryFirst(SELECTORS.pickerSearch, picker);
    if (search) typeInto(search, '');

    const anySelected = results.some((r) => r.status === 'selected' || r.status === 'unverified');
    if (!anySelected) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      return { results, outcome: 'none' };
    }
    return { results, outcome: await waitForUserSend(picker) };
  }

  // ------------------------------------------------------------------
  // סריקת אנשי קשר
  // ------------------------------------------------------------------

  function findScroller(root) {
    const candidates = [root, ...root.querySelectorAll('div')];
    return candidates.find((el) => el.scrollHeight > el.clientHeight + 20
      && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) || null;
  }

  function collectNames(root, names) {
    root.querySelectorAll(SELECTORS.scanRow).forEach((row) => {
      // שורה בתוך שורה – לוקחים רק את החיצונית (השם הוא ה-span[title] הראשון בה)
      const parentRow = row.parentElement && row.parentElement.closest(SELECTORS.scanRow);
      if (parentRow && root.contains(parentRow)) return;
      const title = row.querySelector('span[title]');
      const name = title && title.getAttribute('title').trim();
      if (name) names.add(name);
    });
  }

  const STEP_MS = 300;

  // ---- נעילת המסך בזמן סריקה ----
  // שכבה שקופה מעל WhatsApp שחוסמת לחיצות, גלילה ומקלדת של המשתמש (לא את הגלילה של הסריקה עצמה)
  const OVERLAY_ID = 'wa-bl-scan-overlay';
  const blockInput = (e) => {
    if (!e.isTrusted) return; // אירועים שהתוסף עצמו שולח (למשל Escape בסוף) עוברים
    e.preventDefault();
    e.stopPropagation();
  };
  const BLOCKED_EVENTS = ['keydown', 'keypress', 'keyup', 'wheel', 'mousedown', 'click', 'touchstart'];

  function lockScreen(text) {
    let overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(11,20,26,.55);'
        + 'display:flex;align-items:center;justify-content:center;cursor:wait';
      const box = document.createElement('div');
      box.style.cssText = 'background:#fff;color:#1f2933;direction:rtl;text-align:center;padding:22px 28px;'
        + 'border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.35);min-width:260px;'
        + 'font:15px/1.5 -apple-system,"Segoe UI",Arial,sans-serif';
      const title = document.createElement('div');
      title.style.cssText = 'font-weight:700;font-size:17px;margin-bottom:6px;color:#128c7e';
      title.textContent = 'סורק אנשי קשר וקבוצות';
      const line = document.createElement('div');
      line.className = 'wa-bl-line';
      const note = document.createElement('div');
      note.style.cssText = 'margin-top:8px;font-size:13px;color:#6b7785';
      note.textContent = 'המסך נעול עד סוף הסריקה – לא צריך לגעת בכלום.';
      box.append(title, line, note);
      overlay.append(box);
      document.documentElement.append(overlay);
      BLOCKED_EVENTS.forEach((t) => window.addEventListener(t, blockInput, true));
    }
    overlay.querySelector('.wa-bl-line').textContent = text;
  }

  function unlockScreen() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.remove();
    BLOCKED_EVENTS.forEach((t) => window.removeEventListener(t, blockInput, true));
  }

  function secondsText(ms) {
    const sec = Math.max(1, Math.ceil(ms / 1000));
    return sec === 1 ? 'כשנייה' : `כ-${sec} שניות`;
  }

  function report(msg) {
    chrome.runtime.sendMessage({ type: 'scanProgress', ...msg }).catch(() => {});
  }

  // שולח לפאנל הצד הערכה של הזמן שנותר לסריקה (לפי כמה נשאר לגלול)
  function reportScanProgress(scroller, step, stuck, found) {
    const remainingPx = Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
    const remainingSteps = Math.ceil(remainingPx / step) + (3 - stuck); // + בדיקות הסיום
    const remainingMs = remainingSteps * (STEP_MS + 30);
    lockScreen(`נותרו ${secondsText(remainingMs)} · נמצאו ${found}`);
    report({ phase: 'scanning', remainingMs, found });
  }

  // גולל לראש הרשימה ומחכה שהיא באמת שם (רשימה וירטואלית צריכה זמן לצייר את השורות העליונות)
  async function scrollToTop(scroller) {
    let atTop = 0;
    const deadline = Date.now() + 5000;
    while (atTop < 3 && Date.now() < deadline) {
      scroller.scrollTop = 0;
      await sleep(150);
      atTop = scroller.scrollTop === 0 ? atTop + 1 : 0;
    }
    await sleep(400);
  }

  async function scanContacts() {
    lockScreen('מכין את הסריקה...');
    report({ phase: 'preparing' });
    try {
      // עדיפות לחלון "שלח אל" – הוא כולל גם אנשי קשר בלי שיחה, ואלה בדיוק השמות שהשליחה מחפשת
      const picker = await waitFor(findPicker, 20000);
      const root = picker || document.querySelector(SELECTORS.chatList);
      if (!root) throw new Error('לא נמצאה רשימת צ\'אטים. ודא שאתה מחובר ל-WhatsApp Web.');
      await sleep(600);

      // חיפוש שנשאר בחלון היה מסנן את הרשימה
      const search = picker && queryFirst(SELECTORS.pickerSearch, picker);
      if (search && search.textContent + (search.value || '')) {
        typeInto(search, '');
        await sleep(300);
      }

      const names = new Set();
      const scroller = findScroller(root);
      if (scroller) {
        lockScreen('גולל לראש הרשימה...');
        await scrollToTop(scroller);
        let stuck = 0;
        let last = -1;
        while (stuck < 3 && names.size < 5000) {
          collectNames(root, names);
          const step = Math.max(200, scroller.clientHeight * 0.7);
          reportScanProgress(scroller, step, stuck, names.size);
          scroller.scrollTop += step;
          await sleep(STEP_MS);
          stuck = scroller.scrollTop === last ? stuck + 1 : 0;
          last = scroller.scrollTop;
        }
        scroller.scrollTop = 0;
      }
      collectNames(root, names);

      if (picker) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      }
      return { names: [...names], source: picker ? 'picker' : 'chats' };
    } finally {
      unlockScreen();
    }
  }

  // ------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const handlers = {
      selectAndWait: () => selectAndWait(msg.names),
      scanContacts: () => scanContacts(),
      setAttachments: async () => {
        attachments = { id: msg.id, files: msg.files.map(base64ToFile) };
        return {};
      },
      sendMedia: () => sendMedia(msg.name, msg.caption, msg.attachId),
      forwardAndWait: () => forwardAndWait(msg.sourceChat, msg.messageId, msg.names),
      cancelWait: async () => { if (cancelWaiting) cancelWaiting(); return {}; },
    };
    const handler = msg && handlers[msg.type];
    if (!handler) return false;
    handler()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // תשובה אסינכרונית
  });

  // ------------------------------------------------------------------
  // כפתור "רשימות תפוצה" בתפריט הצד של WhatsApp (מתחת לצ'אטים/שיחות/סטטוס/ערוצים/קהילות).
  // Chrome לא מאפשר לפתוח פאנל צד בלי לחיצה של המשתמש, אז זו הדרך הכי קצרה.
  // אם התפריט לא נמצא (WhatsApp שינה מבנה) – מוצג כפתור צף במקומו.
  // ------------------------------------------------------------------
  const NAV_ID = 'wa-bl-nav-item';
  const FLOAT_ID = 'wa-bl-float';
  const LOGO_SVG = `
    <svg viewBox="0 0 128 128" width="100%" height="100%" aria-hidden="true" style="display:block">
      <circle cx="64" cy="64" r="64" fill="#5cbd6d"/>
      <g transform="translate(64 64) scale(1.4) translate(-64 -64)">
        <path d="M45 48 L45 58.5 L62 64 L45 69.5 L45 80 L88 64 Z" fill="#111" stroke="#111" stroke-width="4" stroke-linejoin="round"/>
      </g>
    </svg>`;

  function togglePanel(anchor) {
    chrome.runtime.sendMessage({ type: 'togglePanel' }).then((res) => {
      if (res && res.ok) return;
      showTip(anchor, 'לחץ על אייקון "רשימות תפוצה" בסרגל של Chrome כדי לפתוח את הפאנל.');
    }).catch(() => {});
  }

  function showTip(anchor, text) {
    const r = anchor.getBoundingClientRect();
    const tip = document.createElement('div');
    tip.textContent = text;
    tip.style.cssText = `position:fixed;z-index:2147483647;top:${Math.round(r.top)}px;left:${Math.round(r.right + 10)}px;`
      + 'max-width:220px;padding:8px 10px;border-radius:6px;background:#1f2933;color:#fff;direction:rtl;'
      + 'font:13px/1.4 -apple-system,"Segoe UI",Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    document.body.append(tip);
    setTimeout(() => tip.remove(), 5000);
  }

  // מוצא את קבוצת הכפתורים העליונה בתפריט הצד לפי מיקום (לא לפי טקסט – עובד בכל שפה):
  // עמודה של כפתורים קטנים בקצה המסך, בחצי העליון.
  function findNavGroup() {
    const nearEdge = (r) => r.left < 100 || r.right > window.innerWidth - 100;
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter((b) => {
      if (b.closest(`#${NAV_ID}, #${FLOAT_ID}`)) return false;
      const r = b.getBoundingClientRect();
      return r.width > 20 && r.width < 80 && r.height > 20 && r.height < 80
        && nearEdge(r) && r.top < window.innerHeight * 0.6;
    });

    // לכל כפתור עולים עד 4 רמות ומחפשים הורה שמכיל כמה כפתורים כאלה בילדים שונים
    const groups = new Map(); // container -> Set(item)
    for (const b of buttons) {
      let el = b;
      for (let i = 0; i < 4 && el.parentElement; i++) {
        const parent = el.parentElement;
        if (!groups.has(parent)) groups.set(parent, new Set());
        groups.get(parent).add(el);
        el = parent;
      }
    }
    let best = null;
    for (const [container, items] of groups) {
      if (items.size >= 3 && (!best || items.size > best.items.size)) best = { container, items };
    }
    return best;
  }

  function buildNavItem(template) {
    const item = document.createElement('div');
    item.id = NAV_ID;
    // אותה מחלקה כמו פריט קיים בתפריט – לקבל אותם מרווחים
    if (template && template.className && typeof template.className === 'string') item.className = template.className;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'רשימות תפוצה – פתיחה/סגירה';
    btn.setAttribute('aria-label', 'פתיחה או סגירה של רשימות תפוצה');
    btn.style.cssText = 'width:40px;height:40px;padding:6px;margin:0 auto;display:block;border:0;border-radius:50%;'
      + 'background:transparent;cursor:pointer;transition:background .15s';
    btn.innerHTML = LOGO_SVG;
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(134,150,160,.2)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
    btn.addEventListener('click', () => togglePanel(btn));
    item.append(btn);
    return item;
  }

  function injectNavItem() {
    const existing = document.getElementById(NAV_ID);
    if (existing && existing.isConnected) return true;
    const group = findNavGroup();
    if (!group) return false;
    const items = [...group.container.children].filter((c) => group.items.has(c));
    const last = items[items.length - 1];
    last.after(buildNavItem(last));
    return true;
  }

  function addFloatingButton() {
    if (document.getElementById(FLOAT_ID)) return;
    const btn = document.createElement('button');
    btn.id = FLOAT_ID;
    btn.type = 'button';
    btn.title = 'רשימות תפוצה';
    btn.style.cssText = 'position:fixed;bottom:90px;right:20px;z-index:2147483647;width:44px;height:44px;padding:0;'
      + 'border:0;border-radius:50%;background:none;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35)';
    btn.innerHTML = LOGO_SVG;
    btn.addEventListener('click', () => togglePanel(btn));
    document.body.append(btn);
  }

  // WhatsApp בונה את הדף מחדש לעתים קרובות – מחזירים את הכפתור אם נעלם (לכל היותר פעם בחצי שנייה)
  const startedAt = Date.now();
  let scheduled = false;
  function ensureButton() {
    scheduled = false;
    if (injectNavItem()) {
      const float = document.getElementById(FLOAT_ID);
      if (float) float.remove();
    } else if (Date.now() - startedAt > 15000) {
      addFloatingButton();
    }
  }
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(ensureButton, 500);
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', () => setTimeout(ensureButton, 300));
  ensureButton();
})();
