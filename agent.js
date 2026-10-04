// Steam Overlay Access - agent injected into Steam's CEF pages by soa_daemon.py.
//
// Runs in two kinds of JS contexts:
//  * SharedJSContext: owns every overlay popup window (toolbar, friends list,
//    game overview, context menus, toasts). One agent drives all of them.
//    In Big Picture the overlay is Steam's gamepad UI: there Steam's own focus
//    navigation stays in charge and the agent only speaks what gets focus.
//  * a standalone overlay web page (guides, discussions, web browser): the
//    agent drives just that page ("page mode").
//
// It adds a screen-reader style virtual cursor on top of the overlay DOM and
// sends everything that should be spoken to the daemon through the
// __soaBridge CDP binding.
(() => {
  'use strict';
  if (window.__soa) { try { window.__soa.destroy(); } catch (e) { /* old instance gone */ } }

  const CFG = Object.assign({ echo: true, toasts: true, chat: true }, /*__SOA_CONFIG__*/{});
  const SHARED = /(^|\.)steamloopback\.host$/.test(location.hostname);
  // Web pages are only ours when the in-game overlay browser shows them, never
  // the desktop client's own store/community views.
  if (!SHARED && (window.top !== window || !/GameOverlay/.test(navigator.userAgent))) return;

  const L = {
    opened: 'Steam overlay', closed: 'Overlay closed', window: 'window', menu: 'menu',
    button: 'button', link: 'link', edit: 'edit', checkbox: 'checkbox', radio: 'radio button',
    tab: 'tab', menuitem: 'menu item', slider: 'slider', combo: 'combo box', option: 'option',
    heading: 'heading', image: 'image', password: 'password edit',
    checked: 'checked', unchecked: 'not checked', selected: 'selected', expanded: 'expanded',
    collapsed: 'collapsed', disabled: 'unavailable', unlabeled: 'unlabeled',
    empty: 'No items', top: 'Top', bottom: 'Bottom', noControl: 'No more controls',
    editing: 'Editing', blank: 'blank', space: 'space', star: 'star',
    noHeading: 'No more headings', of: 'of', noWindow: 'No other windows', notification: 'Notification', close: 'Close',
    search: 'Search', contextMenu: 'Context menu', web: 'web page',
    mainMenu: 'Main menu', quickAccess: 'Quick access menu',
    help: 'Up and down arrows move by item. Left and right arrows or Tab move by control. ' +
      'H and Shift H move by heading. Home and End jump to the first and last item. Enter activates. Menu key or Shift F10 opens the context menu. ' +
      'F6 switches between overlay windows. Backspace closes the current window or menu. F2 says where you are. F3 reads from here. Control stops speech. ' +
      'Tab leaves an edit field. Shift Tab or Escape closes the overlay.',
    gamepadHelp: 'Big Picture overlay. Move with the arrow keys or the controller, the focused item is spoken. ' +
      'Enter or the A button activates. Escape or the B button goes back. F2 says where you are. F3 reads from here. Control stops speech.',
  };

  const send = (msg) => { try { window.__soaBridge && window.__soaBridge(JSON.stringify(msg)); } catch (e) { /* daemon gone */ } };
  const say = (text, interrupt = true) => { text = clean(text).replace(/\.+\. /g, '. '); if (text) send({ t: 'say', text, interrupt }); };
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // ---------------------------------------------------------------- DOM model

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'LINK', 'META']);
  const FIELD_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
  const CONTROL_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'switch', 'slider', 'textbox', 'combobox', 'treeitem', 'searchbox']);
  const ICON_NAMES = { X_Line: 'close', X: 'close', MagnifyingGlass: 'search', DownArrowContextMenu: 'contextMenu' };
  const VIEW_TITLES = { MainMenu: 'mainMenu', QuickAccess: 'quickAccess' };
  const GAMEPAD_UI = 4; // EUIMode of Big Picture windows
  const GENERIC_CLASSES = new Set(['DialogButton', 'Focusable', 'Panel', 'Primary', 'Secondary', 'Disabled', 'Active']);

  const reactKey = (el, prefix) => { for (const k in el) if (k.startsWith(prefix)) return k; return null; };
  const reactProps = (el) => { const k = reactKey(el, '__reactProps$'); return k ? el[k] : null; };
  const hasReactClick = (el) => { const p = reactProps(el); return !!(p && (p.onClick || p.onDoubleClick || p.onMouseDown)); };

  const isEditable = (el) => !!el && el.nodeType === 1 && (el.tagName === 'TEXTAREA' || el.isContentEditable ||
    (el.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|range|file|image|color|hidden)$/i.test(el.type)));

  function isControl(el, cs) {
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'SUMMARY') return true;
    if (FIELD_TAGS.has(tag)) return el.type !== 'hidden';
    if (tag === 'A') return el.hasAttribute('href') || hasReactClick(el);
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return true;
    if (CONTROL_ROLES.has(el.getAttribute('role'))) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && +ti >= 0) return true;
    if (hasReactClick(el)) return true;
    if (cs.cursor === 'pointer') {
      const p = el.parentElement;
      return !p || el.ownerDocument.defaultView.getComputedStyle(p).cursor !== 'pointer';
    }
    return false;
  }

  // A control is one item unless it wraps other controls that carry their own
  // text (then it is just a container, e.g. a card with several links in it).
  function isLeafControl(el, win) {
    if (FIELD_TAGS.has(el.tagName) || el.tagName === 'BUTTON' || el.tagName === 'A' || el.isContentEditable) return true;
    for (const d of el.querySelectorAll('*')) {
      if (FIELD_TAGS.has(d.tagName) && d.type !== 'hidden') return false;
      if (!clean(d.textContent)) continue;
      const cs = win.getComputedStyle(d);
      if (cs.display === 'none') continue;
      if (isControl(d, cs)) return false;
    }
    return true;
  }

  function collect(win) {
    const items = [];
    const doc = win.document;
    const blockCache = new WeakMap();
    const blockOf = (el) => {
      let b = blockCache.get(el);
      if (b) return b;
      b = el;
      while (b.parentElement && win.getComputedStyle(b).display.startsWith('inline')) b = b.parentElement;
      blockCache.set(el, b);
      return b;
    };
    const pushText = (text, parent, heading) => {
      text = clean(text);
      if (!text) return;
      if (win.getComputedStyle(parent).visibility === 'hidden') return;
      const block = blockOf(parent);
      const last = items[items.length - 1];
      if (last && last.kind !== 'control' && last.el === block) { last.text += ' ' + text; return; }
      items.push({ kind: heading ? 'heading' : 'text', el: block, text });
    };
    const walk = (root, heading) => {
      for (const node of root.childNodes) {
        if (node.nodeType === 3) { pushText(node.textContent, root, heading); continue; }
        if (node.nodeType !== 1 || SKIP_TAGS.has(node.tagName)) continue;
        if (node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('data-text') || node.classList.contains('Hidden')) continue;
        const cs = win.getComputedStyle(node);
        if (cs.display === 'none') continue;
        if (isControl(node, cs) && isLeafControl(node, win)) {
          const r = node.getBoundingClientRect();
          if ((r.width > 0 && r.height > 0) || clean(node.textContent)) items.push({ kind: 'control', el: node });
          continue;
        }
        const tag = node.tagName;
        if (tag === 'svg' || tag === 'SVG' || tag === 'CANVAS' || tag === 'VIDEO') continue;
        if (tag === 'IMG') { if (clean(node.alt)) pushText(node.alt, node.parentElement, heading); continue; }
        if (tag === 'IFRAME') { try { if (node.contentDocument) walk(node.contentDocument.body, heading); } catch (e) { /* cross-origin */ } continue; }
        walk(node, heading || /^H[1-6]$/.test(tag) || node.getAttribute('role') === 'heading');
      }
    };
    if (doc.body) walk(doc.body, false);
    return items;
  }

  function innerLabel(el, win) {
    let out = '';
    const walk = (root) => {
      for (const node of root.childNodes) {
        if (node.nodeType === 3) { out += ' ' + node.textContent; continue; }
        if (node.nodeType !== 1 || SKIP_TAGS.has(node.tagName)) continue;
        if (node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('data-text') || node.classList.contains('Hidden')) continue;
        const cs = win.getComputedStyle(node);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (node.tagName === 'IMG') { out += ' ' + (node.alt || ''); continue; }
        const al = node.getAttribute('aria-label');
        if (al) { out += ' ' + al; continue; }
        walk(node);
      }
    };
    walk(el);
    return clean(out);
  }

  function reactText(x, depth = 0) {
    if (x == null || depth > 6) return '';
    if (typeof x === 'string') return x;
    if (typeof x === 'number') return String(x);
    if (Array.isArray(x)) return x.map((c) => reactText(c, depth + 1)).filter(Boolean).join(' ');
    if (x.props) {
      const p = x.props;
      return reactText(p.children, depth + 1) || reactText(p.title, depth + 1) || reactText(p.label, depth + 1) ||
        reactText(p.strTitle, depth + 1) || reactText(p.text, depth + 1);
    }
    return '';
  }

  // Steam keeps most icon-button names only in React tooltip props.
  function reactTooltip(el) {
    const fk = reactKey(el, '__reactFiber$');
    let f = fk ? el[fk] : null;
    // The DOM node may point at the stale half of React's fiber pair; props
    // read from that one lag one render behind (e.g. a toggled tooltip).
    if (f && f.alternate) {
      let root = f;
      while (root.return) root = root.return;
      if (root.stateNode && root.stateNode.current !== root) f = f.alternate;
    }
    for (let i = 0; f && i < 12; i++, f = f.return) {
      if (i > 0 && typeof f.type === 'string' && f.stateNode && f.stateNode !== el && f.stateNode.children.length > 1) break;
      const p = f.memoizedProps;
      if (!p) continue;
      for (const k of ['toolTipContent', 'tooltip', 'strTooltip', 'title']) {
        const t = clean(reactText(p[k]));
        if (t) return t;
      }
    }
    return '';
  }

  const splitCamel = (s) => s.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');

  function classLabel(el) {
    const icon = (el.matches('[class*="SVGIcon_"]') ? el : el.querySelector('[class*="SVGIcon_"]'));
    if (icon) {
      const cls = icon.getAttribute('class') || '';
      const m = cls.match(/SVGIcon_(?!Button\b)(\w+)/);
      if (m) return L[ICON_NAMES[m[1]]] || splitCamel(m[1]);
    }
    const names = (el.getAttribute('class') || '').split(/\s+/).filter((c) => /^[A-Za-z][a-z]+([A-Z][a-z]+)*$/.test(c) && !GENERIC_CLASSES.has(c));
    return names.length ? splitCamel(names[names.length - 1]) : '';
  }

  function controlLabel(el, win) {
    const doc = el.ownerDocument;
    let t = el.getAttribute('aria-label');
    if (t) return clean(t);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { t = clean(lb.split(/\s+/).map((id) => { const n = doc.getElementById(id); return n ? n.textContent : ''; }).join(' ')); if (t) return t; }
    if (FIELD_TAGS.has(el.tagName)) {
      if (el.labels && el.labels.length) { t = clean(el.labels[0].textContent); if (t) return t; }
      t = clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name'));
      if (el.type === 'button' || el.type === 'submit') t = clean(el.value) || t;
      return t;
    }
    t = innerLabel(el, win);
    if (t) return t;
    t = clean(el.getAttribute('title') || el.getAttribute('data-tooltip-text') || el.getAttribute('placeholder'));
    if (t) return t;
    for (let p = el.parentElement, i = 0; p && i < 3; p = p.parentElement, i++) {
      if (p.children.length > 1 || clean(p.textContent) !== clean(el.textContent)) break;
      t = clean(p.getAttribute('aria-label') || p.getAttribute('title'));
      if (t) return t;
    }
    t = reactTooltip(el) || classLabel(el);
    if (t) return t;
    for (let p = el.parentElement, i = 0; p && i < 2; p = p.parentElement, i++) {
      t = innerLabel(p, win);
      if (!t) continue;
      return t.length <= 80 && p.querySelectorAll('button, a, [role="button"]').length <= 1 ? t : '';
    }
    return '';
  }

  function controlRole(el) {
    const role = el.getAttribute('role');
    const tag = el.tagName;
    const custom = clean(el.getAttribute('aria-roledescription'));
    if (custom) return custom.toLowerCase();
    if (tag === 'TEXTAREA' || el.isContentEditable || role === 'textbox' || role === 'searchbox') return L.edit;
    if (tag === 'SELECT' || role === 'combobox') return L.combo;
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'checkbox') return L.checkbox;
      if (type === 'radio') return L.radio;
      if (type === 'range') return L.slider;
      if (type === 'password') return L.password;
      if (type === 'button' || type === 'submit' || type === 'reset') return L.button;
      return L.edit;
    }
    if (role === 'checkbox' || role === 'switch' || role === 'menuitemcheckbox') return L.checkbox;
    if (role === 'radio' || role === 'menuitemradio') return L.radio;
    if (role === 'tab') return L.tab;
    if (role === 'menuitem') return L.menuitem;
    if (role === 'option' || role === 'treeitem') return L.option;
    if (role === 'slider') return L.slider;
    if (role === 'link' || (tag === 'A' && el.hasAttribute('href'))) return L.link;
    if (role === 'button' || tag === 'BUTTON' || tag === 'SUMMARY') return L.button;
    return L.button;
  }

  function controlState(el) {
    const out = [];
    const cls = ' ' + (el.getAttribute('class') || '') + ' ';
    const a = (n) => el.getAttribute(n);
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) out.push(el.checked ? L.checked : L.unchecked);
    else if (a('aria-checked')) out.push(a('aria-checked') === 'true' ? L.checked : L.unchecked);
    if (a('aria-selected') === 'true' || / (selected|Selected) /.test(cls)) out.push(L.selected);
    if (a('aria-expanded')) out.push(a('aria-expanded') === 'true' ? L.expanded : L.collapsed);
    else if (/ (Collapsed|collapsed) /.test(cls)) out.push(L.collapsed);
    if (el.disabled || a('aria-disabled') === 'true' || / (Disabled|disabled) /.test(cls)) out.push(L.disabled);
    if (el.tagName === 'INPUT' && el.type === 'range') out.push(el.value);
    else if (a('aria-valuetext') || a('aria-valuenow')) out.push(a('aria-valuetext') || a('aria-valuenow'));
    else if (el.tagName === 'SELECT') out.push(el.selectedOptions.length ? el.selectedOptions[0].textContent : '');
    else if (isEditable(el)) {
      const v = el.type === 'password' ? '' : clean('value' in el ? el.value : el.textContent);
      out.push(v || L.blank);
    } else {
      // Gamepad UI: a focusable row wrapping the actual slider.
      const inner = el.querySelector('[role="slider"][aria-valuenow]');
      if (inner) {
        const v = +inner.getAttribute('aria-valuenow');
        const fraction = !inner.hasAttribute('aria-valuemax') && v >= 0 && v <= 1;
        out.push(fraction ? Math.round(v * 100) + '%' : inner.getAttribute('aria-valuetext') || inner.getAttribute('aria-valuenow'));
      }
    }
    return out.filter(Boolean).join(', ');
  }

  function describe(item, win) {
    if (item.kind === 'text') return item.text;
    if (item.kind === 'heading') return item.text + ', ' + L.heading;
    const el = item.el;
    // The gamepad UI also focuses plain panels of text: those are not buttons.
    const st = wins.get(win);
    const panel = !!st && st.gamepad && el.tagName === 'DIV' && !el.getAttribute('role') && !el.isContentEditable && !hasReactClick(el);
    const role = panel ? '' : controlRole(el);
    let label = controlLabel(el, win);
    if (isEditable(el) && !('value' in el) && label === clean(el.textContent)) label = '';
    const state = controlState(el);
    return [label || (panel || role === L.edit || role === L.password ? '' : L.unlabeled), role, state].filter(Boolean).join(', ');
  }

  // ------------------------------------------------------------ window state

  const wins = new Map(); // Window -> state
  const S = { lastToast: '', lastToastAt: 0, current: null, inWeb: false, remote: false, suppressWinFocus: 0, lastFocusSpoken: 0, shown: new Set(), lastSpokenWindow: null, suppressFocus: 0, timer: null, toastTimers: new Map(), toastViews: new Set(), openedAt: 0, openPrefix: '' };

  function overlayPopups() {
    const out = [];
    if (!SHARED) { if (document.body) out.push({ key: 'page', win: window, toast: false, appid: 0 }); return out; }
    if (!window.g_PopupManager) return out;
    for (const [key, p] of window.g_PopupManager.m_mapPopups) {
      const win = p.m_popup;
      // One popup in a bad state must not stop every other window from being found.
      try { if (!win || win.closed || !win.document || !win.document.body) continue; } catch (e) { continue; }
      const tb = p.m_rgParams && p.m_rgParams.target_browser;
      const toast = /notificationtoasts/i.test(key);
      const inGame = (tb && tb.m_unPID) || /_uid[1-9]\d*$/.test(key);
      // Toasts are spoken everywhere, also on the desktop outside of a game.
      if (!inGame && !toast) continue;
      out.push({ key, win, toast, appid: tb ? tb.m_unAppID : 0, popup: p, gamepad: !!tb && tb.m_eUIMode === GAMEPAD_UI });
    }
    // Big Picture keeps its main menu, quick access menu and toasts in browser
    // views: windows of this context that the popup manager does not list.
    const seen = new Set(out.map((o) => o.win));
    const usable = (win) => { try { return !!win && !seen.has(win) && !win.closed && !!win.document.body; } catch (e) { return false; } };
    const roots = new Map(out.filter((o) => o.gamepad).map((o) => [o.win, o]));
    const nav = window.FocusNavController;
    for (const ctx of (roots.size && nav && nav.m_rgAllContexts) || []) {
      const root = roots.get(ctx.m_rootWindow);
      if (!root) continue;
      for (const tree of ctx.m_rgGamepadNavigationTrees || []) {
        const win = tree.m_window;
        if (!usable(win)) continue;
        seen.add(win);
        out.push({ key: win.name, win, toast: false, appid: root.appid, gamepad: true });
      }
    }
    for (const win of S.toastViews) {
      if (usable(win)) out.push({ key: win.name, win, toast: true, appid: 0 });
      else if (!seen.has(win)) S.toastViews.delete(win);
    }
    return out;
  }

  function hook(info) {
    const { win } = info;
    const st = { key: info.key, toast: info.toast, appid: info.appid, popup: info.popup, gamepad: !!info.gamepad, cursor: null, items: null, off: [], editEcho: '', spoken: '', recheck: 0, lead: [], leadAt: 0, lastToast: '', toastSince: 0 };
    const on = (target, ev, fn, opts) => { target.addEventListener(ev, fn, opts); st.off.push(() => target.removeEventListener(ev, fn, opts)); };
    const mo = new win.MutationObserver((records) => {
      st.items = null;
      if (st.toast) scheduleToast(win, st); else if (st.gamepad) scheduleRecheck(win, st); else if (CFG.chat) announceChat(win, records);
    });
    const watch = { childList: true, subtree: true, characterData: true };
    // Gamepad UI: a toggle or slider changes under the focus without moving it.
    if (st.gamepad) Object.assign(watch, { attributes: true, attributeFilter: ['aria-checked', 'aria-selected', 'aria-expanded', 'aria-valuenow', 'aria-valuetext'] });
    mo.observe(win.document.documentElement, watch);
    st.off.push(() => { mo.disconnect(); clearTimeout(st.recheck); });
    if (st.toast) {
      st.off.push(() => { clearTimeout(S.toastTimers.get(win)); S.toastTimers.delete(win); });
      if (CFG.toasts) hideToastFromAT(win);
      send({ t: 'log', text: 'toast window: ' + st.key });
    }
    if (!st.toast) {
      on(win, 'keydown', onKeyDown, true);
      on(win, 'focus', (e) => { if (e.target === win || e.target === win.document) onWindowFocus(win); }, true);
      on(win, 'focusin', (e) => onFocusIn(win, e), true);
      on(win, 'input', (e) => onInput(win, e), true);
      const style = win.document.createElement('style');
      style.textContent = '[data-soa-cursor]{outline:3px solid #ffd400 !important;outline-offset:2px !important;}';
      (win.document.head || win.document.documentElement).appendChild(style);
      st.off.push(() => style.remove());
    }
    wins.set(win, st);
  }

  function unhook(win) {
    const st = wins.get(win);
    if (!st) return;
    for (const f of st.off) { try { f(); } catch (e) { /* window already destroyed */ } }
    try { if (st.cursor) st.cursor.removeAttribute('data-soa-cursor'); } catch (e) { /* ditto */ }
    wins.delete(win);
    S.shown.delete(win);
    if (S.current === win) S.current = null;
  }

  const isShown = (win) => {
    try { return !win.closed && win.document.visibilityState === 'visible' && !!clean(win.document.body.textContent); } catch (e) { return false; }
  };

  function windowTitle(win) {
    const st = wins.get(win);
    if (!SHARED) return clean(win.document.title) || L.web;
    let t = clean(win.document.title);
    if (/^SP Overlay/.test(t)) t = L.opened;
    if (!t || /^about:blank/.test(t)) { const k = st.key.split('_'); t = splitCamel(k[0] === 'OverlayBrowser' && k[1] ? k[1] : k[0]); }
    if (/^contextmenu/i.test(st.key)) t = L.menu;
    // Browser views are titled with their internal name, e.g. MainMenu_uid68.
    if (t === st.key) { const k = st.key.split('_')[0]; t = L[VIEW_TITLES[k]] || splitCamel(k); }
    return t;
  }

  function appName(st) {
    try { const o = st.appid && window.appStore.GetAppOverviewByAppID(st.appid); return o ? o.display_name : ''; } catch (e) { return ''; }
  }

  function items(win) {
    const st = wins.get(win);
    if (!st.items) st.items = collect(win);
    return st.items;
  }

  function cursorIndex(win) {
    const st = wins.get(win);
    if (!st.cursor) return -1;
    const list = items(win);
    let i = list.findIndex((it) => it.el === st.cursor);
    if (i < 0 && st.cursor.isConnected) i = list.findIndex((it) => it.el.contains(st.cursor) || st.cursor.contains(it.el));
    return i;
  }

  function setCursor(win, item) {
    const st = wins.get(win);
    try { if (st.cursor) st.cursor.removeAttribute('data-soa-cursor'); } catch (e) { /* stale node */ }
    st.cursor = item ? item.el : null;
    if (!item || st.gamepad) return; // the gamepad UI draws its own focus ring and scrolls by itself
    item.el.setAttribute('data-soa-cursor', '');
    try { item.el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* detached */ }
  }

  const webViews = (win) => { const st = wins.get(win); return (st && st.popup && st.popup.m_rgChildBrowserViews) || []; };

  function firstIndex(win, list) {
    if (!SHARED) return 0;
    // Start on the first real control, not on the window's own close button.
    const isClose = (it) => !!it.el.querySelector('[class*="SVGIcon_X_Line"]');
    let i = list.findIndex((it) => it.kind === 'control' && !isClose(it));
    if (i < 0) i = list.findIndex((it) => it.kind === 'control');
    return Math.max(i, 0);
  }

  // Gamepad UI: the item Steam's own navigation has focused, if any.
  function focusItem(win) {
    const el = win.document.activeElement;
    return el && el !== win.document.body && el.nodeType === 1 ? { kind: 'control', el } : null;
  }

  function speakFocus(win, lead) {
    const st = wins.get(win);
    const item = focusItem(win);
    setCursor(win, item);
    st.spoken = item ? describe(item, win) : '';
    // Nothing focused yet: keep the lead-in, so that the item which gets
    // focus a moment later does not cut the window announcement short.
    st.lead = item ? [] : lead;
    st.leadAt = Date.now();
    say(lead.concat(st.spoken).filter(Boolean).join('. '));
  }

  function announceWindow(win, prefix) {
    const st = wins.get(win);
    if (st.gamepad) {
      const title = windowTitle(win);
      S.lastSpokenWindow = win;
      speakFocus(win, [prefix, prefix && title === L.opened ? '' : title]);
      return;
    }
    const list = items(win);
    let i = cursorIndex(win);
    const fresh = i < 0;
    if (fresh) i = firstIndex(win, list);
    // Steam puts focus straight into e.g. the chat entry: say so, since typing goes there.
    const active = win.document.activeElement;
    const editing = isEditable(active) && win.document.hasFocus() ? list.findIndex((it) => it.el === active) : -1;
    if (editing >= 0) i = editing;
    const title = windowTitle(win);
    const bare = /^contextmenu/i.test(st.key) || title === L.opened;
    const parts = [bare ? (prefix && title === L.opened ? '' : title) : title + ', ' + (SHARED ? L.window : L.web)];
    if (prefix) parts.unshift(prefix);
    // A small window is a dialog: its message matters more than its first button.
    if (SHARED && fresh && list.length <= 8) {
      for (const it of list) if (it.kind !== 'control' && it.text !== title) parts.push(it.text);
    }
    if (editing >= 0) parts.push(L.editing);
    if (list.length) { setCursor(win, list[i]); parts.push(describe(list[i], win)); } else parts.push(L.empty);
    S.lastSpokenWindow = win;
    say(parts.filter(Boolean).join('. '));
  }

  // Tells overlay web pages whether they own the keyboard. Steam offers no
  // reliable way to pull key focus out of a web view, so while another window
  // is current the page forwards its keys here instead (see remoteKey).
  const setWeb = (inWeb) => { S.inWeb = inWeb; if (SHARED) send({ t: 'webmode', web: inWeb }); };

  function takeKeyFocus(win) {
    S.suppressWinFocus = Date.now() + 600; // focus events caused below are not the user switching windows
    try {
      const isBackdrop = (w) => /^desktopoverlay/.test(wins.get(w).key);
      for (const w of S.shown) {
        for (const bv of webViews(w)) bv.SetFocus(false);
        if (w !== win) w.SteamClient.Window.SetKeyFocus(false);
      }
      // Raising any plain window is what really moves focus out of a web view.
      if (isBackdrop(win) || webViews(win).length) {
        const helper = [...S.shown].find((w) => w !== win && !isBackdrop(w) && !webViews(w).length);
        if (helper) helper.SteamClient.Window.BringToFront();
      }
      // The full-screen backdrop must not be raised above the other windows,
      // and raising a browser window hands focus straight back to its page.
      else win.SteamClient.Window.BringToFront();
      win.SteamClient.Window.SetKeyFocus(true);
    } catch (e) { /* window or view gone */ }
  }

  function setCurrent(win, prefix) {
    S.current = win;
    setWeb(false);
    // Big Picture shows its menu a moment after the overlay itself: do not
    // let that cut off the opening announcement.
    if (!prefix && wins.get(win).gamepad && Date.now() - S.openedAt < 1500) prefix = S.openPrefix;
    // A window that only frames a web page: the page's own agent speaks once
    // it has focus, so do not talk over it with the browser chrome.
    if (!wins.get(win).gamepad && webViews(win).length && !win.document.hasFocus()) { say([prefix, windowTitle(win) + ', ' + L.window].filter(Boolean).join('. ')); return; }
    announceWindow(win, prefix);
  }

  // Polls popup creation and visibility: Steam reuses hidden popups, so there
  // is no single event that says "this overlay window is now on screen".
  function tick() {
    const wasOpen = S.shown.size > 0; // before unhooking: a quitting game destroys its windows outright
    const infos = overlayPopups();
    const live = new Set(infos.map((i) => i.win));
    for (const win of [...wins.keys()]) if (!live.has(win)) unhook(win);
    for (const info of infos) if (!wins.has(info.win)) hook(info);
    for (const [win, st] of wins) if (st.toast) pollToast(win, st);

    const shown = new Set();
    for (const [win, st] of wins) if (!st.toast && isShown(win)) shown.add(win);
    const fresh = [...shown].filter((w) => !S.shown.has(w));
    S.shown = shown;

    if (!SHARED) {
      if (!wasOpen && shown.size && document.hasFocus()) onWindowFocus(window);
      return;
    }
    if (!shown.size) {
      if (wasOpen) { S.current = null; say(L.closed); }
      return;
    }
    const focused = [...shown].find((w) => w.document.hasFocus());
    if (!wasOpen) {
      const target = focused || [...shown].find((w) => webViews(w).length) || (shown.has(S.current) ? S.current : [...shown][0]);
      S.openedAt = Date.now();
      S.openPrefix = clean(L.opened + ', ' + appName(wins.get(target)));
      setCurrent(target, S.openPrefix);
    } else if (fresh.length) {
      setCurrent(fresh[fresh.length - 1]);
    } else if (!shown.has(S.current)) {
      setCurrent(focused || [...shown][shown.size - 1]);
    }
  }

  function onWindowFocus(win) {
    if (!wins.has(win) || !S.shown.has(win)) return;
    if (!SHARED) {
      if (Date.now() - S.lastFocusSpoken < 700) return;
      S.lastFocusSpoken = Date.now();
      S.current = win;
      S.remote = false;
      send({ t: 'pagefocus', title: document.title });
      announceWindow(win);
      return;
    }
    if ((S.current === win && !S.inWeb) || S.suppressWinFocus > Date.now()) return;
    // Big Picture: focus passing through the empty backdrop says nothing new.
    if (wins.get(win).gamepad && !focusItem(win) && S.shown.has(S.current)) return;
    setCurrent(win);
  }

  function onFocusIn(win, e) {
    if (S.suppressFocus > Date.now() || !S.shown.has(win)) return;
    const el = e.target;
    if (!el || el.nodeType !== 1 || el === win.document.body) return;
    if (wins.get(win).gamepad) {
      const st = wins.get(win);
      if (S.current === win && st.cursor === el) return;
      const lead = S.current !== win ? [Date.now() - S.openedAt < 1500 ? S.openPrefix : '', windowTitle(win)] : Date.now() - st.leadAt < 1500 ? st.lead : [];
      S.current = win;
      speakFocus(win, lead);
      return;
    }
    const list = items(win);
    const item = list.find((it) => it.el === el) || list.find((it) => it.kind === 'control' && (it.el.contains(el) || el.contains(it.el)));
    if (!item) return;
    const st = wins.get(win);
    if (S.current === win && st.cursor === item.el) return;
    S.current = win;
    setCursor(win, item);
    say(describe(item, win));
  }

  // ------------------------------------------------------------------ toasts

  // Desktop toasts are real windows that Chromium exposes to the system
  // screen reader, which then reads their internal name
  // ("notificationtoasts_10016_desktop") and undescribed images. Blank them
  // out for assistive tech; the toast text is spoken by us instead.
  function hideToastFromAT(win) {
    try {
      win.document.title = '';
      const root = win.document.getElementById('popup_target') || win.document.body;
      if (root) root.setAttribute('aria-hidden', 'true');
    } catch (e) { /* window gone */ }
  }

  // Hooked at creation time so the name is already gone when the window appears.
  const originalOpen = SHARED ? window.open : null;
  if (SHARED && CFG.toasts) {
    window.open = function (url, name) {
      const w = originalOpen.apply(this, arguments);
      if (w && /notificationtoasts/i.test(String(name))) { S.toastViews.add(w); queueMicrotask(() => hideToastFromAT(w)); }
      return w;
    };
  }

  const toastText = (win) => clean(win.document.body.innerText);

  // Waits until the toast has stopped changing, so that a toast rendered in
  // several steps is spoken once - but not forever when it keeps changing.
  function scheduleToast(win, st) {
    if (!CFG.toasts) return;
    if (S.toastTimers.has(win)) {
      if (Date.now() - st.toastSince > 1500) return;
      clearTimeout(S.toastTimers.get(win));
    } else st.toastSince = Date.now();
    S.toastTimers.set(win, setTimeout(() => { S.toastTimers.delete(win); readToast(win, st); }, 400));
  }

  function readToast(win, st) {
    let text = '';
    try { text = toastText(win); } catch (e) { return; }
    if (!text || text === st.lastToast) { if (!text) st.lastToast = ''; return; }
    st.lastToast = text;
    // The same toast can be rendered once per running game and on the desktop.
    if (S.lastToast === text && Date.now() - S.lastToastAt < 4000) { send({ t: 'log', text: 'toast repeated in ' + st.key }); return; }
    S.lastToast = text;
    S.lastToastAt = Date.now();
    send({ t: 'log', text: 'toast from ' + st.key });
    say(L.notification + ': ' + text, false);
  }

  // Called on every tick for what the mutation observer cannot see: a toast
  // that was already rendered when its window got hooked, one that only
  // became visible through a style change, or a window whose document Steam
  // replaced after we hooked it.
  function pollToast(win, st) {
    if (!CFG.toasts || S.toastTimers.has(win)) return;
    let text = '';
    try { text = toastText(win); } catch (e) { return; }
    if (text !== st.lastToast) scheduleToast(win, st);
  }

  // Gamepad UI: speaks the focused item again when it changed in place.
  function scheduleRecheck(win, st) {
    clearTimeout(st.recheck);
    st.recheck = setTimeout(() => {
      if (S.current !== win || !S.shown.has(win)) return;
      const item = focusItem(win);
      if (!item || item.el !== st.cursor) return;
      const text = describe(item, win);
      if (text === st.spoken) return;
      st.spoken = text;
      say(text);
    }, 300);
  }

  // New chat lines are spoken as they arrive. A big batch is history being
  // loaded, not conversation, and stays silent.
  function announceChat(win, records) {
    if (!S.shown.has(win)) return;
    const added = [];
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1 || !n.parentElement || !n.parentElement.closest('.chatHistory')) continue;
        if (n.classList.contains('timeDivision')) continue;
        added.push(n);
      }
    }
    if (!added.length || added.length > 3) return;
    for (const n of added) say(innerLabel(n, win), false);
  }

  // -------------------------------------------------------------- navigation

  function move(win, delta, kind) {
    const controlsOnly = !!kind;
    kind = kind === true ? 'control' : kind;
    const list = items(win);
    if (!list.length) { say(L.empty); return; }
    let i = cursorIndex(win);
    let j = i;
    if (i < 0) j = delta > 0 ? -1 : list.length;
    const step = delta > 0 ? 1 : -1;
    let left = Math.abs(delta);
    let found = -1;
    for (j += step; j >= 0 && j < list.length; j += step) {
      if (controlsOnly && list[j].kind !== kind) continue;
      found = j;
      if (--left <= 0) break;
    }
    if (found < 0) {
      const edge = kind === 'heading' ? L.noHeading : controlsOnly ? L.noControl : (delta > 0 ? L.bottom : L.top);
      say(edge + (i >= 0 ? '. ' + describe(list[i], win) : ''));
      return;
    }
    setCursor(win, list[found]);
    say(describe(list[found], win));
  }

  function jump(win, toEnd) {
    const list = items(win);
    if (!list.length) { say(L.empty); return; }
    const item = list[toEnd ? list.length - 1 : 0];
    setCursor(win, item);
    say(describe(item, win));
  }

  function currentItem(win) {
    const i = cursorIndex(win);
    return i < 0 ? null : items(win)[i];
  }

  function mouse(el, win, types, extra) {
    const r = el.getBoundingClientRect();
    const init = Object.assign({ bubbles: true, cancelable: true, composed: true, view: win, button: 0, buttons: 1, detail: 1,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      screenX: win.screenX + r.left + r.width / 2, screenY: win.screenY + r.top + r.height / 2 }, extra);
    for (const type of types) {
      const Ctor = type.startsWith('pointer') ? win.PointerEvent : win.MouseEvent;
      el.dispatchEvent(new Ctor(type, Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, init)));
    }
  }

  function activate(win) {
    const item = currentItem(win);
    if (!item) { say(L.empty); return; }
    const el = item.el;
    if (item.kind !== 'control') { say(describe(item, win)); return; }
    if (isEditable(el) || el.tagName === 'SELECT') {
      S.suppressFocus = Date.now() + 300;
      if (SHARED) takeKeyFocus(win);
      el.focus();
      say(L.editing + ', ' + describe(item, win));
      return;
    }
    const before = describe(item, win);
    S.suppressFocus = Date.now() + 300;
    mouse(el, win, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    if (el.matches('.friend')) mouse(el, win, ['mousedown', 'mouseup', 'click', 'dblclick'], { detail: 2 });
    setTimeout(() => {
      if (S.current !== win || !wins.has(win)) return;
      const now = currentItem(win);
      if (!now) return;
      const after = describe(now, win);
      if (after !== before) say(after);
    }, 400);
  }

  function contextMenu(win) {
    const item = currentItem(win);
    if (!item) return;
    const target = item.el.querySelector('.ContextMenuButton') || item.el;
    if (target !== item.el) mouse(target, win, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    else mouse(target, win, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'contextmenu'], { button: 2, buttons: 2 });
  }

  function slide(win, el, dir) {
    const step = +el.step || 1;
    const v = Math.min(+el.max || 100, Math.max(+el.min || 0, +el.value + dir * step));
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(v));
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
    say(String(v));
  }

  // F6 order: every visible overlay window, and right after a browser window
  // the web page it frames (which is a separate CEF target with its own agent).
  function cycle(dir) {
    if (!SHARED) { send({ t: 'cycle', dir, title: document.title }); return; }
    const entries = [];
    for (const win of S.shown) {
      entries.push({ win, web: null });
      for (const bv of webViews(win)) entries.push({ win, web: bv });
    }
    if (entries.length < 2) { say(L.noWindow + (S.current ? '. ' + windowTitle(S.current) : '')); return; }
    const i = entries.findIndex((en) => en.win === S.current && !!en.web === S.inWeb);
    const next = entries[(i + dir + entries.length) % entries.length];
    S.current = next.win;
    setWeb(!!next.web);
    if (next.web) {
      try {
        next.win.SteamClient.Window.BringToFront();
        setTimeout(() => { try { next.web.SetFocus(true); } catch (e) { /* view gone */ } send({ t: 'webfocus' }); }, 200);
      } catch (e) { /* window gone */ }
      return;
    }
    takeKeyFocus(next.win);
    announceWindow(next.win);
  }

  const framingWindow = (title) => {
    const framing = [...S.shown].filter((w) => webViews(w).length);
    return framing.find((w) => title && w.document.body.textContent.includes(title)) || framing[0];
  };

  // Called by the daemon when F6 was pressed inside an overlay web page.
  function cycleFromPage(dir, title) {
    const win = framingWindow(title);
    if (win) { S.current = win; S.inWeb = true; }
    cycle(dir);
  }

  // Called by the daemon when an overlay web page really received focus.
  function pageFocused(title) {
    const win = framingWindow(title);
    if (!win) return;
    S.current = win;
    setWeb(true);
  }

  // Escape would close the whole overlay, so closing one window or menu gets
  // its own key.
  function closeWindow(win) {
    const st = wins.get(win);
    if (/^desktopoverlay/.test(st.key)) { say(windowTitle(win)); return; }
    if (/^contextmenu/i.test(st.key)) { try { win.close(); } catch (e) { /* already gone */ } return; }
    const item = items(win).find((it) => it.kind === 'control' && it.el.querySelector('[class*="SVGIcon_X_Line"], [class*="SVGIcon_X "]'));
    if (item) mouse(item.el, win, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    else { try { win.SteamClient.Window.Close(); } catch (e) { /* window gone */ } }
  }

  function whereAmI(win) {
    const list = items(win);
    const i = cursorIndex(win);
    const parts = [windowTitle(win) + ', ' + (SHARED ? L.window : L.web)];
    const focused = wins.get(win).gamepad && focusItem(win);
    if (focused) parts.push(describe(focused, win));
    else if (i >= 0) parts.push(describe(list[i], win), (i + 1) + ' ' + L.of + ' ' + list.length);
    else parts.push(L.empty);
    say(parts.join('. '));
  }

  function readFromHere(win) {
    const list = items(win);
    const i = Math.max(0, cursorIndex(win));
    say(list.slice(i, i + 200).map((it) => describe(it, win)).join('. '));
  }

  // ---------------------------------------------------------------- keyboard

  // Navigation commands; returns true when the key was consumed.
  function command(win, key, shift, ctrl) {
    const cur = currentItem(win);
    const onSlider = cur && cur.el.tagName === 'INPUT' && cur.el.type === 'range';
    switch (key) {
      case 'ArrowDown': move(win, 1, false); return true;
      case 'ArrowUp': move(win, -1, false); return true;
      case 'ArrowRight': if (onSlider) slide(win, cur.el, 1); else move(win, 1, true); return true;
      case 'ArrowLeft': if (onSlider) slide(win, cur.el, -1); else move(win, -1, true); return true;
      case 'h': case 'H': if (ctrl) return false; move(win, shift ? -1 : 1, 'heading'); return true;
      case 'Tab': move(win, shift ? -1 : 1, true); return true;
      case 'PageDown': move(win, 10, false); return true;
      case 'PageUp': move(win, -10, false); return true;
      case 'Home': jump(win, false); return true;
      case 'End': jump(win, true); return true;
      case 'Enter': case ' ': activate(win); return true;
      case 'ContextMenu': contextMenu(win); return true;
      case 'F10': if (!shift) return false; contextMenu(win); return true;
      case 'Backspace': if (SHARED) closeWindow(win); else send({ t: 'closeweb', title: document.title }); return true;
      case 'F6': cycle(shift ? -1 : 1); return true;
      case 'F1': say(L.help); return true;
      case 'F2': whereAmI(win); return true;
      case 'F3': readFromHere(win); return true;
      default: return false;
    }
  }

  function echoKey(active, e) {
    if (!CFG.echo || e.ctrlKey || e.altKey || !isEditable(active)) return;
    const key = e.key;
    const pw = active.type === 'password';
    if (key.length === 1 && key >= ' ') say(pw ? L.star : (key === ' ' ? L.space : key));
    else if (key === 'Backspace') {
      const v = 'value' in active ? active.value : active.textContent;
      const pos = 'selectionStart' in active && active.selectionStart != null ? active.selectionStart : v.length;
      const ch = v.charAt(pos - 1);
      if (ch) say(pw ? L.star : (ch === ' ' ? L.space : ch));
    }
  }

  // Big Picture: navigation keys stay with Steam, which moves the real focus.
  function onGamepadKey(win, e) {
    const key = e.key;
    if (key === 'Control') send({ t: 'stop' });
    else if (key === 'F1') say(L.gamepadHelp);
    else if (key === 'F2') whereAmI(win);
    else if (key === 'F3') readFromHere(win);
    else { echoKey(win.document.activeElement, e); return; }
    if (key !== 'Control') { e.preventDefault(); e.stopImmediatePropagation(); }
  }

  function onKeyDown(e) {
    const key = e.key;
    const swallow = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (!SHARED && S.remote) {
      if (key === 'Control') send({ t: 'stop' });
      else if (key !== 'Shift' && key !== 'Alt' && key !== 'Meta' && !e.altKey && !e.metaKey) send({ t: 'key', key, shift: e.shiftKey, ctrl: e.ctrlKey });
      swallow();
      return;
    }
    const src = e.view || (e.target && e.target.ownerDocument && e.target.ownerDocument.defaultView);
    if (src && wins.has(src) && wins.get(src).gamepad) { onGamepadKey(src, e); return; }
    if (!S.current || !wins.has(S.current)) { if (src && wins.has(src) && isShown(src)) S.current = src; else return; }
    const win = S.current;
    if (key === 'Control') { send({ t: 'stop' }); return; }
    if (key === 'Shift' || key === 'Alt' || key === 'Meta') return;

    const active = src && src.document.activeElement;
    if (isEditable(active) || (active && active.tagName === 'SELECT')) {
      // Escape is not usable here: Steam closes the whole overlay on it.
      const singleLine = active.tagName === 'INPUT';
      if (key === 'Tab' || (singleLine && (key === 'ArrowDown' || key === 'ArrowUp'))) {
        swallow();
        S.suppressFocus = Date.now() + 300;
        active.blur();
        if (key === 'Tab') move(win, e.shiftKey ? -1 : 1, true); else move(win, key === 'ArrowDown' ? 1 : -1, false);
        return;
      }
      if (key === 'F6') { swallow(); active.blur(); cycle(e.shiftKey ? -1 : 1); return; }
      if (/^F\d+$/.test(key)) { if (command(win, key, e.shiftKey, e.ctrlKey)) swallow(); return; }
      echoKey(active, e);
      return;
    }
    if (e.altKey || e.metaKey) return;
    // The overlay's key translation has no name for the Menu key: it arrives blank.
    const menuKey = key === '\u0000' && !e.code && !e.keyCode;
    if (command(win, menuKey ? 'ContextMenu' : key, e.shiftKey, e.ctrlKey)) swallow();
  }

  // Called by the daemon with a key an overlay web page forwarded to us.
  function remoteKey(key, shift, ctrl) {
    if (S.current && wins.has(S.current)) command(S.current, key, shift, ctrl);
  }

  function onInput(win, e) {
    const el = e.target;
    if (el && el.tagName === 'SELECT' && el.selectedOptions.length) say(el.selectedOptions[0].textContent);
  }

  // --------------------------------------------------------------- lifecycle

  S.timer = setInterval(() => { try { tick(); } catch (err) { send({ t: 'log', text: 'tick: ' + (err && err.stack || err) }); } }, 250);

  window.__soa = {
    version: 5,
    cycle,
    cycleFromPage,
    pageFocused,
    remoteKey,
    // Daemon relay: Backspace was pressed inside an overlay web page.
    closeFraming(title) { const w = framingWindow(title); if (w) closeWindow(w); },
    setRemote(v) { S.remote = !!v; },
    // Daemon relay: a toast window that was opened before this agent was injected.
    addToast(win) { if (!CFG.toasts || !win) return false; S.toastViews.add(win); return true; },
    // Debug/test helper: put the cursor on the first item whose description contains `text`.
    find(text, key) {
      for (const [w, st] of wins) {
        if (key ? !st.key.startsWith(key) : w !== S.current) continue;
        const item = items(w).find((it) => describe(it, w).toLowerCase().includes(text.toLowerCase()));
        if (!item) return null;
        S.current = w;
        setCursor(w, item);
        return describe(item, w);
      }
      return null;
    },
    // Daemon relay: F6 in the shared context just moved focus into a web page.
    announceIfFocused() { if (!SHARED && document.visibilityState === 'visible' && document.hasFocus() && Date.now() - S.lastFocusSpoken > 1000) { S.lastFocusSpoken = Date.now(); S.current = window; S.remote = false; announceWindow(window); } },
    state: () => ({ shared: SHARED, windows: [...wins.values()].map((s) => s.key), toasts: [...wins.values()].filter((s) => s.toast).map((s) => s.key), shown: [...S.shown].map((w) => wins.get(w).key), current: S.current && wins.get(S.current) ? wins.get(S.current).key : null }),
    dump: (key) => { for (const [w, s] of wins) if (!key || s.key.startsWith(key)) return collect(w).map((it) => describe(it, w)); return null; },
    destroy() {
      clearInterval(S.timer);
      if (originalOpen) window.open = originalOpen;
      for (const t of S.toastTimers.values()) clearTimeout(t);
      for (const win of [...wins.keys()]) unhook(win);
      delete window.__soa;
    },
  };
  send({ t: 'log', text: 'agent loaded (' + (SHARED ? 'shared' : 'page: ' + location.host) + ')' });
})();
