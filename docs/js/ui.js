/* Audabook — small UI kit: element builder, icons, dialogs, toasts, progress, and menus. */
(function (root) {
  'use strict';
  const SS = root.SS;
  const UI = (SS.ui = {});

  /** el('div', { class: 'x', text: 'hi', onclick: fn }, [children]) */
  UI.el = function (tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k in node && typeof v !== 'string') node[k] = v;
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    if (children != null) {
      for (const c of Array.isArray(children) ? children : [children]) {
        if (c == null || c === false) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  };
  const el = UI.el;

  // 24x24 icon paths.
  const ICONS = {
    play: 'M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z',
    pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
    stop: 'M6.5 6.5h11v11h-11z',
    record: 'M12 5.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13z',
    start: 'M6 6h2.2v12H6zM9.6 12l8.4 6V6z',
    end: 'M15.8 6H18v12h-2.2zM6 18l8.4-6L6 6z',
    split: 'M9.6 7.6A3.9 3.9 0 0 0 10 6a4 4 0 1 0-4 4c.6 0 1.1-.1 1.6-.4L10 12l-2.4 2.4A3.9 3.9 0 0 0 6 14a4 4 0 1 0 4 4c0-.6-.1-1.1-.4-1.6L12 14l7 7h3v-1zM6 8a2 2 0 1 1 0-4a2 2 0 0 1 0 4zm0 12a2 2 0 1 1 0-4a2 2 0 0 1 0 4zM19 3l-6 6 2 2 7-7V3z',
    trash: 'M9 3h6l1 2h4v2H4V5h4zM6 8.5h12l-.9 11.6a1 1 0 0 1-1 .9H7.9a1 1 0 0 1-1-.9z',
    trim: 'M17 15h2V7a2 2 0 0 0-2-2H9v2h8zM7 17V1H5v4H1v2h4v10a2 2 0 0 0 2 2h10v4h2v-4h4v-2z',
    undo: 'M12.5 8c-2.65 0-5.05 1-6.9 2.6L2 7v9h9l-3.62-3.62A7.95 7.95 0 0 1 12.5 10.5c3.54 0 6.55 2.31 7.6 5.5l2.37-.78A10.5 10.5 0 0 0 12.5 8z',
    redo: 'M18.4 10.6A10.4 10.4 0 0 0 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16a8 8 0 0 1 7.6-5.5c1.95 0 3.73.72 5.12 1.88L13 16h9V7z',
    zoomIn: 'M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 14.4l.3.3v.8l5 5 1.5-1.5zm-6 0a4.5 4.5 0 1 1 0-9a4.5 4.5 0 0 1 0 9zM10 7H9v2H7v1h2v2h1v-2h2V9h-2z',
    zoomOut: 'M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 14.4l.3.3v.8l5 5 1.5-1.5zm-6 0a4.5 4.5 0 1 1 0-9a4.5 4.5 0 0 1 0 9zM7 9h5v1H7z',
    fit: 'M3 5v4h2V5h4V3H5a2 2 0 0 0-2 2zm2 10H3v4a2 2 0 0 0 2 2h4v-2H5zm14 4h-4v2h4a2 2 0 0 0 2-2v-4h-2zm0-16h-4v2h4v4h2V5a2 2 0 0 0-2-2z',
    settings: 'M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6a.5.5 0 0 0 .1-.6l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.3 7.3 0 0 0-1.7-1l-.4-2.6A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.4l-.4 2.7a7.6 7.6 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.4a.5.5 0 0 0 .1.7L4.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6a.5.5 0 0 0-.1.6l2 3.5c.1.2.4.3.6.2l2.5-1c.5.4 1.1.7 1.7 1l.4 2.6c0 .3.2.5.5.5h4c.3 0 .5-.2.5-.4l.4-2.7c.6-.3 1.2-.6 1.7-1l2.5 1c.2.1.5 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.6zM12 15.5a3.5 3.5 0 1 1 0-7a3.5 3.5 0 0 1 0 7z',
    plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
    close: 'M6.4 5L5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z',
    mic: 'M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z',
    import: 'M5 19h14v2H5zM13 3v9.2l3.6-3.6L18 10l-6 6-6-6 1.4-1.4 3.6 3.6V3z',
    export: 'M5 19h14v2H5zM11 16V6.8L7.4 10.4 6 9l6-6 6 6-1.4 1.4L13 6.8V16z',
    caret: 'M7 10l5 5 5-5z',
    help: 'M12 2a10 10 0 1 0 0 20a10 10 0 0 0 0-20zm1 17h-2v-2h2zm2.07-7.75l-.9.92A3.4 3.4 0 0 0 13 15h-2v-.5a4 4 0 0 1 1.17-2.83l1.24-1.26A2 2 0 1 0 10 9H8a4 4 0 1 1 7.07 2.25z',
    logo: 'M4 10.5h2v3H4zM7.5 7h2v10h-2zM11 4h2v16h-2zM14.5 8h2v8h-2zM18 10h2v4h-2z',
    metronome: 'M9.5 3h5l4.2 17H5.3zM11 5.5L7.6 18h8.8L13 5.5zM11.3 15.4l4.6-9.3 1.2.6-4.6 9.3z',
  };

  UI.icon = function (name, size) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size || 20);
    svg.setAttribute('height', size || 20);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'icon');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', ICONS[name] || '');
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    return svg;
  };

  UI.downloadBlob = function (blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: fileName, style: 'display:none' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  };

  // Waits for the browser to paint (falls back to a timer when the tab is hidden).
  UI.nextFrame = function () {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      requestAnimationFrame(() => setTimeout(finish, 0));
      setTimeout(finish, 120);
    });
  };

  /**
   * A modal dialog. Resolves with the clicked button's value (or dismissValue on Esc/backdrop).
   * opts: { title, content (Node|html string), buttons: [{ label, value, kind, id }], onOpen(ctrl), wide }
   */
  UI.dialog = function (opts) {
    return new Promise((resolve) => {
      const body = el('div', { class: 'dlg-body' });
      if (typeof opts.content === 'string') body.innerHTML = opts.content;
      else if (opts.content) body.appendChild(opts.content);
      const btnRow = el('div', { class: 'dlg-buttons' });
      const dlg = el('dialog', { class: 'dlg' + (opts.wide ? ' wide' : '') }, [
        el('div', { class: 'dlg-inner' }, [el('h2', { class: 'dlg-title', text: opts.title }), body, btnRow]),
      ]);
      const buttons = {};
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        if (opts.onClose) opts.onClose(value);
        dlg.close();
        dlg.remove();
        resolve(value);
      };
      const list = opts.buttons || [{ label: 'OK', value: true, kind: 'primary' }];
      list.forEach((b) => {
        const btn = el('button', { class: 'btn ' + (b.kind || ''), type: 'button', text: b.label, onclick: () => finish(b.value) });
        if (b.id) buttons[b.id] = btn;
        if (b.kind === 'primary') btn.setAttribute('autofocus', '');
        btnRow.appendChild(btn);
      });
      const dismissValue = 'dismissValue' in opts ? opts.dismissValue : null;
      dlg.addEventListener('cancel', (e) => {
        e.preventDefault();
        if (opts.dismissible !== false) finish(dismissValue);
      });
      dlg.addEventListener('pointerdown', (e) => {
        if (e.target === dlg && opts.dismissible !== false) finish(dismissValue);
      });
      document.body.appendChild(dlg);
      dlg.showModal();
      if (opts.onOpen) opts.onOpen({ el: dlg, body, buttons, close: finish });
    });
  };

  UI.confirm = function (title, message, okLabel, kind) {
    return UI.dialog({
      title,
      content: el('p', { text: message }),
      buttons: [
        { label: 'Cancel', value: false },
        { label: okLabel || 'OK', value: true, kind: kind || 'primary' },
      ],
      dismissValue: false,
    });
  };

  UI.prompt = function (title, label, value) {
    const input = el('input', { type: 'text', class: 'text-input', value: value || '', maxlength: '80', spellcheck: 'false' });
    return UI.dialog({
      title,
      content: el('label', { class: 'field' }, [el('span', { text: label }), input]),
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'OK', value: 'ok', kind: 'primary', id: 'ok' },
      ],
      onOpen(ctrl) {
        input.focus();
        input.select();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') ctrl.close('ok');
        });
      },
    }).then((v) => (v === 'ok' ? input.value.trim() : null));
  };

  /** A blocking progress window: { set(fraction, text), close() }. */
  UI.progress = function (title) {
    const fill = el('div', { class: 'progress-fill' });
    const text = el('div', { class: 'progress-text', text: ' ' });
    const dlg = el('dialog', { class: 'dlg progress-dlg' }, [
      el('div', { class: 'dlg-inner' }, [el('h2', { class: 'dlg-title', text: title }), el('div', { class: 'progress' }, [fill]), text]),
    ]);
    dlg.addEventListener('cancel', (e) => e.preventDefault());
    document.body.appendChild(dlg);
    dlg.showModal();
    return {
      set(fraction, message) {
        fill.style.width = Math.round(SS.clamp(fraction, 0, 1) * 100) + '%';
        if (message) text.textContent = message;
      },
      close() {
        if (dlg.open) dlg.close();
        dlg.remove();
      },
    };
  };

  /** opts: { kind: 'error'|'success', action: { label, run }, timeout } */
  UI.toast = function (message, opts) {
    opts = opts || {};
    const host = document.getElementById('toasts');
    const t = el('div', { class: 'toast ' + (opts.kind || ''), role: opts.kind === 'error' ? 'alert' : 'status' }, [
      el('span', { class: 'toast-msg', text: message }),
    ]);
    let timer = 0;
    const remove = () => {
      clearTimeout(timer);
      t.classList.add('out');
      setTimeout(() => t.remove(), 200);
    };
    if (opts.action) {
      t.appendChild(el('button', {
        class: 'toast-action', type: 'button', text: opts.action.label,
        onclick: () => {
          remove();
          opts.action.run();
        },
      }));
    }
    t.appendChild(el('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', onclick: remove }, [UI.icon('close', 14)]));
    host.appendChild(t);
    while (host.children.length > 3) host.firstChild.remove();
    timer = setTimeout(remove, opts.timeout || (opts.kind === 'error' ? 9000 : 4500));
    return remove;
  };

  /**
   * Dropdown menus. items: [{ label | label(), action, shortcut, submenu: [...] } | { sep: true }]
   * host: { run(action), canRun(action) }
   */
  class Menu {
    constructor(host) {
      this.host = host;
      this.stack = []; // open dropdown elements, outermost first
      this.onClose = null;
      this.onDocDown = (e) => {
        if (!this.stack.length) return;
        if (this.stack.some((d) => d.contains(e.target))) return;
        if (this.owner && this.owner.contains(e.target)) return; // the owning button toggles itself
        this.close();
      };
      this.onKey = (e) => this.key(e);
      document.addEventListener('pointerdown', this.onDocDown, true);
      root.addEventListener('blur', () => this.close());
      root.addEventListener('resize', () => this.close());
    }

    get isOpen() {
      return this.stack.length > 0;
    }

    open(items, x, y, owner) {
      this.close();
      this.owner = owner || null;
      const dd = this.build(items, 0);
      this.place(dd, x, y);
      document.addEventListener('keydown', this.onKey, true);
      const first = dd.querySelector('.menu-item:not([disabled])');
      if (first) first.focus({ preventScroll: true });
    }

    build(items, level) {
      const dd = el('div', { class: 'menu-dropdown', role: 'menu' });
      for (const item of items) {
        if (item.sep) {
          dd.appendChild(el('div', { class: 'menu-sep', role: 'separator' }));
          continue;
        }
        const label = typeof item.label === 'function' ? item.label() : item.label;
        const enabled = item.submenu ? true : this.host.canRun(item.action);
        const row = el('button', { class: 'menu-item' + (item.submenu ? ' has-sub' : ''), type: 'button', role: 'menuitem', disabled: !enabled }, [
          el('span', { class: 'menu-label', text: label }),
          item.submenu ? UI.icon('end', 14) : el('span', { class: 'menu-shortcut', text: item.shortcut || '' }),
        ]);
        if (item.submenu) {
          row.setAttribute('aria-haspopup', 'true');
          const openSub = () => this.openSub(row, item.submenu, level);
          row.addEventListener('pointerenter', openSub);
          row.addEventListener('click', openSub);
        } else {
          row.addEventListener('pointerenter', () => {
            this.closeAbove(level);
            row.focus({ preventScroll: true });
          });
          row.addEventListener('click', () => {
            this.close();
            this.host.run(item.action);
          });
        }
        dd.appendChild(row);
      }
      dd.dataset.level = level;
      return dd;
    }

    openSub(row, items, level) {
      if (this.stack[level + 1] && this.stack[level + 1].parentRow === row) return;
      this.closeAbove(level);
      const dd = this.build(items, level + 1);
      dd.parentRow = row;
      const r = row.getBoundingClientRect();
      this.place(dd, r.right - 4, r.top - 5, r.left);
      row.classList.add('sub-open');
    }

    place(dd, x, y, flipX) {
      dd.style.left = '0px';
      dd.style.top = '0px';
      document.body.appendChild(dd);
      this.stack.push(dd);
      const w = dd.offsetWidth;
      const h = dd.offsetHeight;
      const vw = root.innerWidth;
      const vh = root.innerHeight;
      if (x + w > vw - 4) x = flipX != null ? Math.max(4, flipX - w + 4) : Math.max(4, vw - w - 4);
      if (y + h > vh - 4) y = Math.max(4, vh - h - 4);
      dd.style.left = x + 'px';
      dd.style.top = y + 'px';
    }

    closeAbove(level) {
      while (this.stack.length > level + 1) {
        const dd = this.stack.pop();
        if (dd.parentRow) dd.parentRow.classList.remove('sub-open');
        dd.remove();
      }
    }

    close() {
      if (!this.stack.length) return;
      this.closeAbove(-1);
      document.removeEventListener('keydown', this.onKey, true);
      this.owner = null;
      if (this.onClose) this.onClose();
    }

    key(e) {
      const dd = this.stack[this.stack.length - 1];
      if (!dd) return;
      const items = Array.from(dd.querySelectorAll('.menu-item:not([disabled])'));
      const i = items.indexOf(document.activeElement);
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === 'Escape') {
        stop();
        if (this.stack.length > 1) {
          const parent = dd.parentRow;
          this.closeAbove(this.stack.length - 2);
          if (parent) parent.focus();
        } else this.close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        stop();
        const down = e.key === 'ArrowDown';
        const next = i < 0 ? items[down ? 0 : items.length - 1] : items[(i + (down ? 1 : items.length - 1)) % items.length];
        if (next) next.focus();
      } else if (e.key === 'ArrowRight' && document.activeElement && document.activeElement.classList.contains('has-sub')) {
        stop();
        document.activeElement.click();
        const sub = this.stack[this.stack.length - 1].querySelector('.menu-item:not([disabled])');
        if (sub) sub.focus();
      } else if (e.key === 'ArrowLeft' && this.stack.length > 1) {
        stop();
        const parent = dd.parentRow;
        this.closeAbove(this.stack.length - 2);
        if (parent) parent.focus();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (this.onArrow) {
          stop();
          this.onArrow(e.key === 'ArrowRight' ? 1 : -1);
        }
      } else if (e.key === 'Tab') {
        stop();
      }
    }
  }
  UI.Menu = Menu;

  /** The File / Edit / Tracks / Help bar. */
  class MenuBar {
    constructor(container, menus, host) {
      this.menus = menus;
      this.menu = new Menu(host);
      this.current = -1;
      this.buttons = menus.map((m, i) => {
        const b = el('button', { class: 'menu-top', type: 'button', text: m.label, 'aria-haspopup': 'true' });
        b.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          if (this.current === i && this.menu.isOpen) this.menu.close();
          else this.open(i);
        });
        b.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
            e.preventDefault();
            this.open(i);
          }
        });
        b.addEventListener('pointerenter', () => {
          if (this.menu.isOpen && this.current !== i) this.open(i);
        });
        container.appendChild(b);
        return b;
      });
      this.menu.onClose = () => {
        if (this.current >= 0) this.buttons[this.current].classList.remove('open');
        this.current = -1;
      };
      this.menu.onArrow = (dir) => this.open((this.current + dir + this.menus.length) % this.menus.length);
    }

    open(i) {
      this.menu.close();
      const b = this.buttons[i];
      const r = b.getBoundingClientRect();
      this.menu.open(this.menus[i].items, r.left, r.bottom + 2, b.parentNode);
      this.current = i;
      b.classList.add('open');
    }
  }
  UI.MenuBar = MenuBar;
})(window);
