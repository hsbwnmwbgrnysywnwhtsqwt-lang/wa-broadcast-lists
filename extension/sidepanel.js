(function () {
  'use strict';

  const WA_URL = 'https://web.whatsapp.com/';
  const WA_MATCH = 'https://web.whatsapp.com/*';
  // WhatsApp מאפשר לשלוח/להעביר ל-5 צ'אטים לכל היותר בכל פעם
  const BATCH_SIZE = 5;
  const BATCH_PAUSE_MS = 1500;

  // ---------------- State ----------------
  // נשמר ב-chrome.storage.local:
  //   contacts:  string[]            – שמות שנסרקו מ-WhatsApp
  //   scannedAt: ISO string
  //   lists:     [{ id, name, members: string[], message, status: { [name]: 'sent' | 'not-found' | 'failed' } }]
  const state = {
    contacts: [],
    scannedAt: null,
    lists: [],
  };

  // State של המסך (לא נשמר)
  const ui = {
    view: 'home',
    currentId: null,
    draft: null,        // { id|null, name, members: Set }
    running: false,
    stopRequested: false,
    waTabId: null,
    inFlight: new Set(), // נמענים בסבב הנוכחי
    attachments: [],     // File[] – תמונות וסרטונים (בזיכרון בלבד, לא נשמרים)
    attachId: '',        // מזהה של רשימת הקבצים הנוכחית (להשוואה מול מה שכבר נשלח לטאב)
    encoded: null,       // { id, files } – הקבצים ב-base64, מוכנים לשליחה לטאב
  };

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function save(keys) {
    const data = {};
    keys.forEach((k) => { data[k] = state[k]; });
    return chrome.storage.local.set(data);
  }

  function showMsg(el, text, kind) {
    el.textContent = text || '';
    el.classList.toggle('error', kind === 'error');
    el.classList.toggle('ok', kind === 'ok');
  }

  const currentList = () => state.lists.find((l) => l.id === ui.currentId) || null;

  // אנשי קשר שלא נשמרו מופיעים ב-WhatsApp כמספר טלפון (למשל "+972 50-123-4567")
  const isPhone = (name) => /^[+\d\s\-().]+$/.test(name) && name.replace(/\D/g, '').length >= 7;
  const collator = new Intl.Collator('he', { numeric: true, sensitivity: 'base' });

  // שמות לפי א"ב, ואחריהם מספרי טלפון
  function sortNames(names) {
    return [...names].sort((a, b) => (isPhone(a) - isPhone(b)) || collator.compare(a, b));
  }

  function contactsInfo() {
    if (!state.contacts.length) return 'עוד לא נסרקו אנשי קשר וקבוצות.';
    const count = `${state.contacts.length} אנשי קשר וקבוצות`;
    if (!state.scannedAt) return count;
    const when = new Date(state.scannedAt).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
    return `${count} · נסרקו ${when}`;
  }

  // ---------------- ניווט בין מסכים ----------------
  function show(view) {
    ui.view = view;
    $('viewHome').hidden = view !== 'home';
    $('viewEdit').hidden = view !== 'edit';
    $('viewSend').hidden = view !== 'send';
    const list = currentList();
    $('title').textContent =
      view === 'home' ? 'רשימות תפוצה'
      : view === 'edit' ? (ui.draft && ui.draft.id ? 'עריכת רשימה' : 'רשימה חדשה')
      : (list ? list.name : '');
    if (view === 'home') renderHome();
    if (view === 'edit') renderEdit();
    if (view === 'send') renderSend();
  }

  // ---------------- דף הבית ----------------
  function renderHome() {
    const ul = $('lists');
    ul.innerHTML = '';
    $('listsEmpty').hidden = state.lists.length > 0;
    state.lists.forEach((list) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = list.name;
      const count = document.createElement('span');
      count.className = 'pill muted';
      count.textContent = `${list.members.length} נמענים`;
      btn.append(name, count);
      btn.addEventListener('click', () => {
        ui.currentId = list.id;
        show('send');
      });
      li.append(btn);
      ul.append(li);
    });
    $('contactsInfoHome').textContent = contactsInfo();
  }

  $('newList').addEventListener('click', () => {
    ui.draft = { id: null, name: '', members: new Set() };
    show('edit');
  });

  // ---------------- עריכת רשימה ----------------
  function renderEdit() {
    $('listName').value = ui.draft.name;
    $('contactFilter').value = '';
    $('onlySelected').checked = false;
    $('deleteList').hidden = !ui.draft.id;
    $('contactsInfoEdit').textContent = contactsInfo();
    showMsg($('editMsg'), '');
    showMsg($('scanMsgEdit'), '');
    renderContacts();
  }

  function renderContacts() {
    const filter = $('contactFilter').value.trim().toLowerCase();
    const onlySelected = $('onlySelected').checked;
    // חברים שכבר ברשימה נשארים מוצגים גם אם לא הופיעו בסריקה האחרונה
    const all = sortNames(new Set([...state.contacts, ...ui.draft.members]));
    const visible = all.filter((n) => !filter || n.toLowerCase().includes(filter));
    const selected = visible.filter((n) => ui.draft.members.has(n));
    const unselected = onlySelected ? [] : visible.filter((n) => !ui.draft.members.has(n));

    const ul = $('contacts');
    const scrollTop = ul.scrollTop; // סימון מזיז שורה בין הקבוצות – שומרים על מיקום הגלילה
    ul.innerHTML = '';

    function addSection(title, names) {
      if (!names.length) return;
      const sep = document.createElement('li');
      sep.className = 'sep';
      sep.textContent = `${title} (${names.length})`;
      ul.append(sep);
      names.forEach((name) => {
        const li = document.createElement('li');
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = name;
        cb.checked = ui.draft.members.has(name);
        const span = document.createElement('span');
        span.dir = 'auto'; // מספרי טלפון ושמות באנגלית מוצגים בכיוון הנכון
        span.textContent = name;
        label.append(cb, span);
        li.append(label);
        ul.append(li);
      });
    }
    addSection('מסומנים', selected);
    addSection('לא מסומנים', unselected);
    ul.scrollTop = scrollTop;

    if (!ul.children.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.style.padding = '10px';
      li.textContent = all.length ? 'אין תוצאות.' : 'לחץ "סרוק מ-WhatsApp" כדי לטעון אנשי קשר וקבוצות.';
      ul.append(li);
    }
    $('editCount').textContent = `${ui.draft.members.size} נבחרו`;
  }

  $('contacts').addEventListener('change', (e) => {
    const cb = e.target;
    if (cb.type !== 'checkbox') return;
    if (cb.checked) ui.draft.members.add(cb.value);
    else ui.draft.members.delete(cb.value);
    renderContacts();
  });

  $('contactFilter').addEventListener('input', renderContacts);
  $('onlySelected').addEventListener('change', renderContacts);
  $('listName').addEventListener('input', () => { ui.draft.name = $('listName').value; });

  $('selectVisible').addEventListener('click', () => {
    $('contacts').querySelectorAll('input[type="checkbox"]').forEach((cb) => ui.draft.members.add(cb.value));
    renderContacts();
  });

  $('clearMembers').addEventListener('click', () => {
    ui.draft.members.clear();
    renderContacts();
  });

  $('saveList').addEventListener('click', () => {
    const name = $('listName').value.trim();
    if (!name) {
      showMsg($('editMsg'), 'יש לתת שם לרשימה.', 'error');
      $('listName').focus();
      return;
    }
    if (ui.draft.members.size === 0) {
      showMsg($('editMsg'), 'יש לבחור לפחות איש קשר או קבוצה אחת.', 'error');
      return;
    }
    const members = sortNames(ui.draft.members);
    let list = ui.draft.id && state.lists.find((l) => l.id === ui.draft.id);
    if (list) {
      list.name = name;
      list.members = members;
      // מנקים סטטוסים של מי שהוסר מהרשימה
      Object.keys(list.status).forEach((n) => { if (!members.includes(n)) delete list.status[n]; });
    } else {
      list = { id: Date.now().toString(36), name, members, message: '', status: {} };
      state.lists.push(list);
    }
    save(['lists']);
    ui.currentId = list.id;
    show('send');
  });

  $('cancelEdit').addEventListener('click', () => show(ui.draft.id ? 'send' : 'home'));

  $('deleteList').addEventListener('click', () => {
    if (!confirm(`למחוק את הרשימה "${ui.draft.name}"?`)) return;
    state.lists = state.lists.filter((l) => l.id !== ui.draft.id);
    save(['lists']);
    ui.currentId = null;
    show('home');
  });

  // ---------------- מסך שליחה ----------------
  const STATUS_LABELS = {
    sending: ['בסבב הנוכחי', 'warn'],
    sent: ['נשלח', ''],
    'not-found': ['לא נמצא', 'error'],
    failed: ['לא נשלח', 'error'],
    pending: ['ממתין', 'muted'],
  };

  // הסטטוסים שייכים להודעה שנשלחה (list.sentMessage) – הטקסט + הקבצים המצורפים.
  // כותבים הודעה אחרת או מחליפים קבצים – מתחילה שליחה חדשה וכולם חוזרים ל"ממתין".
  function attachSignature() {
    return ui.attachments.map((f) => `${f.name}:${f.size}:${f.lastModified}`).join('|');
  }

  function sendKey(message) {
    const sig = attachSignature();
    return sig ? `${message}\n#files:${sig}` : message;
  }

  function activeStatus(list) {
    return sendKey((list.message || '').trim()) === list.sentMessage ? list.status : {};
  }

  function memberStatus(list, name) {
    if (ui.inFlight.has(name)) return 'sending';
    return activeStatus(list)[name] || 'pending';
  }

  function renderSend() {
    const list = currentList();
    if (!list) return show('home');
    $('sendMessage').value = list.message || '';
    renderMembers();

    $('sendAll').hidden = ui.running;
    $('stopSend').hidden = !ui.running;
    $('resetStatus').disabled = ui.running;
    $('editList').disabled = ui.running;
    $('backHome').disabled = ui.running;
    $('sendMessage').disabled = ui.running;
    renderAttachments();
  }

  // ---------------- תמונות וסרטונים ----------------
  const MAX_TOTAL_BYTES = 40 * 1024 * 1024; // הקבצים עוברים לטאב של WhatsApp בהודעה אחת

  function renderAttachments() {
    const ul = $('attachList');
    ul.querySelectorAll('img, video').forEach((el) => URL.revokeObjectURL(el.src));
    ul.innerHTML = '';
    ui.attachments.forEach((file, index) => {
      const li = document.createElement('li');
      li.title = file.name;
      const isVideo = file.type.startsWith('video/');
      const media = document.createElement(isVideo ? 'video' : 'img');
      media.src = URL.createObjectURL(file);
      if (isVideo) media.muted = true;
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = isVideo ? 'וידאו' : 'תמונה';
      li.append(media, kind);
      if (!ui.running) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'remove';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `הסר את ${file.name}`);
        remove.addEventListener('click', () => {
          ui.attachments.splice(index, 1);
          attachmentsChanged();
        });
        li.append(remove);
      }
      ul.append(li);
    });
    $('addFiles').disabled = ui.running;
    const n = ui.attachments.length;
    $('modeText').textContent = n === 1 && !ui.forwardFailed
      ? 'עם קובץ אחד: הנמען הראשון מקבל אותו בשיחה שלו (התוסף מצרף את הקובץ וכותב את ההודעה ככיתוב, ואתה לוחץ שלח), '
        + 'ואז התוסף מעביר את אותה הודעה לשאר – 5 נמענים בכל לחיצה על החץ הירוק. '
        + 'הודעה שכתבת בעצמך ומעבירים לא מסומנת "הועברה". לא לסגור את הפאנל בזמן שליחה.'
      : n
      ? 'עם כמה קבצים (או כשההעברה לא זמינה) השליחה היא לנמען אחד בכל פעם: התוסף פותח את השיחה, מצרף את הקבצים '
        + 'וכותב את ההודעה ככיתוב, ואתה לוחץ שלח. כדי לשלוח ל-5 בכל פעם – צרף קובץ אחד. לא לסגור את הפאנל בזמן שליחה.'
      : 'השליחה נעשית בסבבים של 5 נמענים. בכל סבב הנמענים מסומנים אוטומטית, '
        + 'ואתה לוחץ על החץ הירוק ב-WhatsApp. אחרי הלחיצה הסבב הבא נפתח לבד. לא לסגור את הפאנל בזמן שליחה.';
  }

  function attachmentsChanged() {
    ui.attachId = ui.attachments.length ? `${Date.now().toString(36)}-${attachSignature().length}` : '';
    ui.encoded = null;
    renderAttachments();
    if (currentList()) renderMembers();
    showMsg($('sendMsg'), '');
  }

  $('addFiles').addEventListener('click', () => $('fileInput').click());

  $('fileInput').addEventListener('change', () => {
    const files = [...$('fileInput').files];
    $('fileInput').value = '';
    const media = files.filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
    const next = [...ui.attachments, ...media];
    const total = next.reduce((sum, f) => sum + f.size, 0);
    if (total > MAX_TOTAL_BYTES) {
      showMsg($('attachMsg'), 'הקבצים גדולים מדי – עד 40MB ביחד.', 'error');
      return;
    }
    showMsg($('attachMsg'), media.length < files.length ? 'אפשר לצרף רק תמונות וסרטונים.' : '', 'error');
    ui.attachments = next;
    attachmentsChanged();
  });

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  async function encodedAttachments() {
    if (!ui.encoded || ui.encoded.id !== ui.attachId) {
      const files = await Promise.all(ui.attachments.map(async (f) => ({
        name: f.name, type: f.type, data: await fileToBase64(f),
      })));
      ui.encoded = { id: ui.attachId, files };
    }
    return ui.encoded;
  }

  function renderMembers() {
    const list = currentList();
    const ul = $('members');
    ul.innerHTML = '';
    sortNames(list.members).forEach((name) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.dir = 'auto';
      span.textContent = name;
      const [text, cls] = STATUS_LABELS[memberStatus(list, name)];
      const pill = document.createElement('span');
      pill.className = `pill ${cls}`;
      pill.textContent = text;
      li.append(span, pill);
      ul.append(li);
    });

    const status = activeStatus(list);
    const sent = list.members.filter((n) => status[n] === 'sent').length;
    $('sendProgress').textContent = `נשלח ל-${sent} מתוך ${list.members.length}`;
    $('sendProgress').classList.toggle('warn', sent < list.members.length);
  }

  $('sendMessage').addEventListener('input', () => {
    const list = currentList();
    if (!list) return;
    list.message = $('sendMessage').value;
    save(['lists']);
    renderMembers();
    showMsg($('sendMsg'), '');
  });

  $('backHome').addEventListener('click', () => show('home'));

  $('editList').addEventListener('click', () => {
    const list = currentList();
    ui.draft = { id: list.id, name: list.name, members: new Set(list.members) };
    show('edit');
  });

  $('resetStatus').addEventListener('click', () => {
    const list = currentList();
    if (!confirm('לאפס את סטטוס השליחה של כל הנמענים?')) return;
    list.status = {};
    save(['lists']);
    showMsg($('sendMsg'), '');
    renderSend();
  });

  // ---------------- תקשורת עם WhatsApp Web ----------------
  async function findWaTab() {
    const tabs = await chrome.tabs.query({ url: WA_MATCH });
    if (tabs.length === 0) return null;
    const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs.find((t) => current && t.id === current.id) || tabs[0];
  }

  // מנווט את הטאב (או פותח חדש) ומחכה שהדף החדש יסיים להיטען
  function navigateAndWait(tab, url) {
    return new Promise((resolve, reject) => {
      let tabId = tab && tab.id;
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        reject(new Error('WhatsApp Web לא נטען בזמן.'));
      }, 60000);
      function onUpdated(id, info) {
        if (id === tabId && info.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve(tabId);
        }
      }
      // מאזינים לפני הניווט כדי לא לפספס את האירוע
      chrome.tabs.onUpdated.addListener(onUpdated);
      const nav = tab
        ? chrome.tabs.update(tab.id, { url, active: true })
        : chrome.tabs.create({ url });
      nav.then((t) => {
        tabId = t.id;
        return chrome.windows.update(t.windowId, { focused: true });
      }).catch(reject);
    });
  }

  // ה-content script נטען קצת אחרי status=complete – מנסים שוב עד שהוא עונה
  async function sendWithRetry(tabId, msg, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await chrome.tabs.sendMessage(tabId, msg);
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await sleep(500);
      }
    }
  }

  // פותח את חלון "שלח אל" של WhatsApp (כמו wa.me/?text=...) ושולח פקודה ל-content script
  async function openPickerAndRun(text, msg, timeoutMs) {
    const url = `${WA_URL}send?text=${encodeURIComponent(text)}`;
    const tabId = await navigateAndWait(await findWaTab(), url);
    ui.waTabId = tabId;
    const res = await sendWithRetry(tabId, msg, timeoutMs);
    if (!res || !res.ok) throw new Error((res && res.error) || 'אין תשובה מהטאב של WhatsApp.');
    return res;
  }

  // ---------------- סריקת אנשי קשר ----------------
  // ספירה לאחור בשני שלבים:
  // 1. עד תחילת הסריקה – WhatsApp נטען מחדש ופותח את חלון "שלח אל". הזמן לא ידוע מראש,
  //    אז מעריכים לפי הפעם הקודמת (scanStartupMs נשמר ב-storage) ומתחילים ב-8 שניות.
  // 2. בזמן הסריקה – content.js מדווח כמה נשאר לגלול.
  const DEFAULT_STARTUP_MS = 8000;
  const DONT_TOUCH = 'המסך של WhatsApp נעול עד סוף הסריקה.';
  let scanMsgEl = null;
  let scanShownSec = Infinity;
  let scanPhase = null;       // 'starting' | 'preparing' | 'scanning'
  let startupTimer = null;
  let scanStartupMs = DEFAULT_STARTUP_MS;

  const secondsText = (sec) => (sec === 1 ? 'כשנייה' : `כ-${sec} שניות`);

  function startStartupCountdown(msgEl) {
    const startedAt = Date.now();
    const tick = () => {
      if (scanPhase === 'scanning') return;
      const left = Math.ceil((scanStartupMs - (Date.now() - startedAt)) / 1000);
      const when = left > 0 ? `בעוד ${secondsText(left)}` : 'בעוד רגע';
      const what = scanPhase === 'preparing' ? 'WhatsApp נטען, מכין את הרשימה...' : 'פותח את WhatsApp Web...';
      showMsg(msgEl, `${what}\nהסריקה תתחיל ${when}. ${DONT_TOUCH}`);
    };
    tick();
    startupTimer = setInterval(tick, 250);
    return startedAt;
  }

  function stopStartupCountdown() {
    clearInterval(startupTimer);
    startupTimer = null;
  }

  let scanStartedAt = 0;

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'scanProgress' || !scanMsgEl) return;
    if (msg.phase === 'preparing') {
      if (scanPhase === 'starting') scanPhase = 'preparing';
      return;
    }
    if (scanPhase !== 'scanning') {
      // הסריקה התחילה – זוכרים כמה זמן לקח עד עכשיו, בשביל ההערכה של הפעם הבאה
      scanPhase = 'scanning';
      stopStartupCountdown();
      scanStartupMs = Math.min(30000, Math.max(2000, Math.round(Date.now() - scanStartedAt)));
      chrome.storage.local.set({ scanStartupMs });
    }
    // לא נותנים למספר לקפוץ למעלה אם ההערכה משתנה תוך כדי
    scanShownSec = Math.max(1, Math.min(scanShownSec, Math.ceil(msg.remainingMs / 1000)));
    showMsg(scanMsgEl, `סורק... נותרו ${secondsText(scanShownSec)} · נמצאו ${msg.found} עד עכשיו\n${DONT_TOUCH}`);
  });

  async function scan(msgEl, btn) {
    btn.disabled = true;
    scanMsgEl = msgEl;
    scanShownSec = Infinity;
    scanPhase = 'starting';
    scanStartedAt = startStartupCountdown(msgEl);
    try {
      const res = await openPickerAndRun('', { type: 'scanContacts' }, 15000);
      if (!res.names.length) throw new Error('לא נמצאו אנשי קשר או קבוצות.');
      state.contacts = sortNames(res.names);
      state.scannedAt = new Date().toISOString();
      save(['contacts', 'scannedAt']);
      showMsg(msgEl, `הסריקה הסתיימה. נמצאו ${res.names.length} אנשי קשר וקבוצות.`, 'ok');
    } catch (err) {
      showMsg(msgEl, err.message, 'error');
    } finally {
      stopStartupCountdown();
      scanMsgEl = null;
      scanPhase = null;
      btn.disabled = false;
      $('contactsInfoHome').textContent = contactsInfo();
      $('contactsInfoEdit').textContent = contactsInfo();
      if (ui.view === 'edit') renderContacts();
    }
  }

  $('scanHome').addEventListener('click', () => scan($('scanMsgHome'), $('scanHome')));
  $('scanEdit').addEventListener('click', () => scan($('scanMsgEdit'), $('scanEdit')));

  // ---------------- שליחה ----------------
  // בלי קבצים: סבבים של 5 בחלון "שלח אל". עם קבצים: נמען אחד בכל פעם בשיחה שלו.
  // בשני המקרים התוסף רק מכין – את "שלח" לוחץ המשתמש.
  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  const STOP_REASONS = {
    closed: 'החלון נסגר בלי לחיצה על שלח. השליחה נעצרה.',
    timeout: 'לא נלחץ "שלח" במשך 10 דקות. השליחה נעצרה.',
  };

  async function runTextSend(list, message, pending, sendMsg) {
    const batches = chunk(pending, BATCH_SIZE);
    for (let i = 0; i < batches.length; i++) {
      if (ui.stopRequested) return;
      const batch = batches[i];
      batch.forEach((n) => ui.inFlight.add(n));
      renderSend();
      showMsg(sendMsg, `סבב ${i + 1} מתוך ${batches.length}: מסמן נמענים...\nאחרי הסימון – לחץ על החץ הירוק ב-WhatsApp.`);

      const res = await openPickerAndRun(message, { type: 'selectAndWait', names: batch }, 15000);
      ui.inFlight.clear();

      const sent = res.outcome === 'sent';
      res.results.forEach((r) => {
        if (r.status === 'not-found' || r.status === 'failed') list.status[r.name] = r.status;
        else if (sent) list.status[r.name] = 'sent';
      });
      save(['lists']);
      renderSend();

      if (res.outcome === 'none') continue; // אף נמען בסבב לא נמצא – עוברים הלאה
      if (!sent) {
        if (ui.stopRequested) return;
        throw new Error(STOP_REASONS[res.outcome] || 'השליחה נעצרה.');
      }
      if (i < batches.length - 1) await sleep(BATCH_PAUSE_MS);
    }
  }

  // שולח לנמען אחד את הקבצים עם ההודעה ככיתוב (בשיחה שלו)
  async function sendOneMedia(tabId, name, message) {
    const msg = { type: 'sendMedia', name, caption: message, attachId: ui.attachId };
    let res = await sendWithRetry(tabId, msg, 20000);
    if (res && res.ok && res.status === 'need-attachments') {
      const enc = await encodedAttachments();
      await sendWithRetry(tabId, { type: 'setAttachments', id: enc.id, files: enc.files }, 20000);
      res = await sendWithRetry(tabId, msg, 20000);
    }
    if (!res || !res.ok) throw new Error((res && res.error) || 'אין תשובה מהטאב של WhatsApp.');
    return res;
  }

  // עם קבצים:
  // • קובץ אחד – הנמען הראשון מקבל אותו רגיל, ואז התוסף מעביר את אותה הודעה לשאר, 5 בכל פעם
  //   (הודעה שכתבת בעצמך ומעבירים לא מסומנת "הועברה"). אם ההעברה לא מצליחה – ממשיכים אחד-אחד.
  // • כמה קבצים – נמען אחד בכל פעם.
  async function runMediaSend(list, message, pending, sendMsg) {
    // פעם אחת בהתחלה: WhatsApp Web נקי (בלי חלון "שלח אל" פתוח מהשליחה הקודמת)
    showMsg(sendMsg, 'פותח את WhatsApp Web...');
    const tabId = await navigateAndWait(await findWaTab(), WA_URL);
    ui.waTabId = tabId;

    const canForward = ui.attachments.length === 1;
    let source = null; // { chat, messageId } – ההודעה שנשלחה ואפשר להעביר
    let queue = [...pending];

    const record = (name, status) => {
      list.status[name] = status;
      save(['lists']);
    };

    while (queue.length) {
      if (ui.stopRequested) return;

      if (source) {
        // העברה ל-5 הבאים
        const batch = queue.slice(0, BATCH_SIZE);
        batch.forEach((n) => ui.inFlight.add(n));
        renderSend();
        const done = list.members.filter((n) => list.status[n] === 'sent').length;
        showMsg(sendMsg, `מעביר ל-${batch.length} נמענים (נשלח ל-${done} מתוך ${list.members.length})...\nאחרי הסימון – לחץ על החץ הירוק ב-WhatsApp.`);

        const res = await sendWithRetry(tabId, { type: 'forwardAndWait', sourceChat: source.chat, messageId: source.messageId, names: batch }, 20000);
        ui.inFlight.clear();
        if (!res || !res.ok) throw new Error((res && res.error) || 'אין תשובה מהטאב של WhatsApp.');
        if (res.unavailable) {
          // לא הצלחנו לפתוח את חלון ההעברה – ממשיכים נמען אחד בכל פעם
          source = null;
          ui.forwardFailed = true;
          renderSend();
          continue;
        }

        const sent = res.outcome === 'sent';
        res.results.forEach((r) => {
          if (r.status === 'not-found' || r.status === 'failed') record(r.name, r.status);
          else if (sent) record(r.name, 'sent');
        });
        renderSend();
        queue = queue.slice(batch.length);
        if (res.outcome === 'none') continue;
        if (!sent) {
          if (ui.stopRequested) return;
          throw new Error(STOP_REASONS[res.outcome] || 'השליחה נעצרה.');
        }
        if (queue.length) await sleep(BATCH_PAUSE_MS);
        continue;
      }

      // שליחה רגילה לנמען אחד
      const name = queue.shift();
      ui.inFlight.add(name);
      renderSend();
      const done = list.members.filter((n) => list.status[n] === 'sent').length;
      showMsg(sendMsg, `פותח את "${name}" ומצרף את הקבצים (נשלח ל-${done} מתוך ${list.members.length})...\nבדוק ולחץ על כפתור השליחה ב-WhatsApp.`);

      const res = await sendOneMedia(tabId, name, message);
      ui.inFlight.clear();
      if (['sent', 'not-found', 'failed'].includes(res.status)) record(name, res.status);
      renderSend();
      if (res.status === 'cancelled' || ui.stopRequested) return;
      if (STOP_REASONS[res.status]) throw new Error(STOP_REASONS[res.status]);

      if (res.status === 'sent' && canForward && res.messageId && !ui.forwardFailed) {
        source = { chat: name, messageId: res.messageId };
      }
      if (queue.length) await sleep(1000);
    }
  }

  $('sendAll').addEventListener('click', async () => {
    const list = currentList();
    const message = $('sendMessage').value.trim();
    const sendMsg = $('sendMsg');
    const withMedia = ui.attachments.length > 0;
    if (!message && !withMedia) {
      showMsg(sendMsg, 'יש לכתוב הודעה או לצרף תמונה או סרטון.', 'error');
      $('sendMessage').focus();
      return;
    }
    const key = sendKey(message);
    if (key !== list.sentMessage) {
      // הודעה חדשה – שליחה חדשה לכל הרשימה
      list.status = {};
      list.sentMessage = key;
      save(['lists']);
    }
    const pending = sortNames(list.members).filter((n) => list.status[n] !== 'sent');
    if (!pending.length) {
      showMsg(sendMsg, 'ההודעה הזו כבר נשלחה לכל הנמענים.\nכתוב הודעה חדשה כדי לשלוח שוב, או "אפס סטטוסים" כדי לשלוח את אותה הודעה שוב.', 'ok');
      return;
    }

    ui.running = true;
    ui.stopRequested = false;
    renderSend();

    try {
      if (withMedia) await runMediaSend(list, message, pending, sendMsg);
      else await runTextSend(list, message, pending, sendMsg);

      const problems = list.members.filter((n) => ['not-found', 'failed'].includes(list.status[n])).length;
      if (ui.stopRequested) showMsg(sendMsg, 'השליחה נעצרה. לחיצה על "שלח" תמשיך מהנמענים שנותרו.');
      else if (problems) showMsg(sendMsg, `הסתיים. ${problems} נמענים לא נשלחו – בדוק את השמות שלהם.`, 'error');
      else showMsg(sendMsg, 'ההודעה נשלחה לכל הנמענים.', 'ok');
    } catch (err) {
      showMsg(sendMsg, `${err.message}\nלחיצה על "שלח" תמשיך מהנמענים שנותרו.`, 'error');
    } finally {
      ui.running = false;
      ui.inFlight.clear();
      renderSend();
    }
  });

  $('stopSend').addEventListener('click', () => {
    ui.stopRequested = true;
    showMsg($('sendMsg'), 'עוצר...');
    // משחרר את ההמתנה ללחיצה על "שלח" בטאב של WhatsApp
    if (ui.waTabId) chrome.tabs.sendMessage(ui.waTabId, { type: 'cancelWait' }).catch(() => {});
  });

  // ---------------- כללי ----------------
  // ---------------- גיבוי: ייצוא / ייבוא ----------------
  const BACKUP_APP = 'wa-broadcast-lists';

  $('exportData').addEventListener('click', () => {
    const data = {
      app: BACKUP_APP,
      version: 1,
      exportedAt: new Date().toISOString(),
      contacts: state.contacts,
      scannedAt: state.scannedAt,
      // סטטוסי שליחה לא נכללים – הם שייכים לשליחה שכבר קרתה
      lists: state.lists.map((l) => ({ name: l.name, members: l.members, message: l.message || '' })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `רשימות-תפוצה-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showMsg($('backupMsg'), `יוצאו ${state.lists.length} רשימות ו-${state.contacts.length} אנשי קשר וקבוצות.`, 'ok');
  });

  $('importData').addEventListener('click', () => $('importFile').click());

  $('importFile').addEventListener('change', async () => {
    const file = $('importFile').files[0];
    $('importFile').value = '';
    if (!file) return;
    const msgEl = $('backupMsg');
    try {
      const data = JSON.parse(await file.text());
      const valid = data && data.app === BACKUP_APP && Array.isArray(data.lists)
        && data.lists.every((l) => l && typeof l.name === 'string' && Array.isArray(l.members));
      if (!valid) throw new Error('הקובץ לא נראה כמו גיבוי של רשימות תפוצה.');

      const existing = data.lists.filter((l) => state.lists.some((x) => x.name === l.name)).length;
      const question = `לייבא ${data.lists.length} רשימות?`
        + (existing ? `\n${existing} רשימות עם אותו שם יוחלפו בגרסה מהקובץ.` : '');
      if (!confirm(question)) return;

      data.lists.forEach((l) => {
        const members = sortNames(new Set(l.members.filter((n) => typeof n === 'string' && n.trim())));
        const message = typeof l.message === 'string' ? l.message : '';
        const list = state.lists.find((x) => x.name === l.name);
        if (list) {
          Object.assign(list, { members, message, status: {}, sentMessage: message.trim() });
        } else {
          state.lists.push({
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            name: l.name, members, message, status: {}, sentMessage: message.trim(),
          });
        }
      });
      if (Array.isArray(data.contacts)) {
        state.contacts = sortNames(new Set([...state.contacts, ...data.contacts.filter((n) => typeof n === 'string')]));
        if (!state.scannedAt) state.scannedAt = data.scannedAt || null;
      }
      await save(['lists', 'contacts', 'scannedAt']);
      renderHome();
      showMsg(msgEl, `יובאו ${data.lists.length} רשימות.`, 'ok');
    } catch (err) {
      showMsg(msgEl, err instanceof SyntaxError ? 'הקובץ פגום.' : err.message, 'error');
    }
  });

  // ---------------- פתיחה/סגירה מהכפתור בתפריט של WhatsApp ----------------
  // הפאנל נרשם אצל ה-background, שיודע כך שהוא פתוח. לחיצה נוספת על הכפתור שולחת "close".
  let panelTabId = null;
  let panelPort = null;

  async function connectToBackground() {
    if (panelTabId === null) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;
      panelTabId = tab.id; // הפאנל שייך לטאב של WhatsApp שבו נפתח
    }
    const port = chrome.runtime.connect({ name: `panel:${panelTabId}` });
    panelPort = port;
    port.onMessage.addListener((msg) => {
      if (msg && msg.type === 'close') requestClose();
    });
    // ה-service worker של Chrome נכבה מדי פעם – מתחברים מחדש כדי שימשיך לדעת שהפאנל פתוח
    port.onDisconnect.addListener(() => setTimeout(connectToBackground, 500));
  }

  function requestClose() {
    const busy = ui.running || scanMsgEl !== null;
    if (busy && !confirm('יש שליחה או סריקה באמצע. לסגור את הפאנל ולעצור אותה?')) return;
    window.close();
    // גיבוי: אם window.close לא סגר את הפאנל – מבקשים מה-background לסגור דרך ה-API של Chrome
    setTimeout(() => { if (panelPort) panelPort.postMessage({ type: 'closeMe' }); }, 300);
  }

  connectToBackground();

  // ---------------- טעינה ----------------
  chrome.storage.local.get(['contacts', 'scannedAt', 'lists', 'scanStartupMs']).then((data) => {
    if (data.scanStartupMs > 0) scanStartupMs = data.scanStartupMs;
    state.contacts = data.contacts || [];
    state.scannedAt = data.scannedAt || null;
    state.lists = data.lists || [];
    // רשימות מלפני sentMessage – הסטטוסים שייכים להודעה שכתובה בהן
    state.lists.forEach((l) => {
      if (l.sentMessage === undefined) l.sentMessage = (l.message || '').trim();
    });
    show('home');
  });
})();
