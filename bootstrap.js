/* 稿纸格子：文字批注(T) 本身带格子背景，宽度锁 25 格，高度按整行吸附 */
var GridBox;

const COLS = 25;
const LINE_H = 1.25;          // 行高 = 字号 * LINE_H，同时写进 CSS
const GRID_COLOR = '#808080';
const AUTO_SNAP = true;
const SIZES = [14, 12, 10, 8, 6];   // 字号档位（大 -> 最小）
const SIZE_NAMES = ['大 100%', '中大 86%', '中 71%', '小 57%', '最小 43%'];
const PREF_SIZE = 'extensions.manuscript-grid.fontSize';
const TAG_TEXT = 'gridbox:text';
const TAG_ROWS = 'gridbox:rows:';

function install() {}
function uninstall() {}

async function startup({ id, version }) {
  await Zotero.initializationPromise;
  GridBox = {
    id, busy: false, state: {}, rowsLive: {}, handlers: [], observerID: null, tabObserverID: null, injectTimer: null,

    log(msg) {
      Zotero.debug('[GridBox] ' + msg);
    },

    geom(item) {
      const pos = JSON.parse(item.annotationPosition);
      const fs = pos.fontSize || 14;
      const [x1, y1, x2, y2] = pos.rects[0];
      return { pos, fs, x1, y1, x2, y2, rowH: fs * LINE_H };
    },

    toFull(str) {
      return str.replace(/​/g, '').replace(/[!-~]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xFEE0)).replace(/[ ⠀]/g, String.fromCharCode(0x3000));
    },

    // 首尾加零宽字符，防止阅读器 trim() 吞掉行首/行尾的全角空格
    mark(str) { return str ? String.fromCharCode(0x200B) + str + String.fromCharCode(0x200B) : str; },

    // 行数记在标签里；评论没变而高度变了 = 用户拖拽 -> 更新行数；评论变了 = Zotero 自动缩高 -> 保持行数
    async snap(item, rowsHint) {
      if (this.busy) return;
      this.busy = true;
      try {
        const g = this.geom(item);
        const rowTag = item.getTags().find(t => t.tag.startsWith(TAG_ROWS));
        const tagRows = rowTag ? parseInt(rowTag.tag.slice(TAG_ROWS.length)) : 0;
        const comment = this.toFull(item.annotationComment || '');
        const lines = comment.split(String.fromCharCode(10)).reduce((n, l) => n + Math.max(1, Math.ceil(Array.from(l).length / COLS)), 0);
        const prev = this.state[item.key];
        const dragged = rowsHint == null && prev && prev.comment === comment && prev.h !== Math.round((g.y2 - g.y1) * 10);
        const heightRows = Math.max(1, Math.round((g.y2 - g.y1) / g.rowH));
        let rows = rowsHint || (dragged || !tagRows ? heightRows : tagRows);
        rows = Math.max(rows, lines);
        const rect = [g.x1, g.y2 - rows * g.rowH, g.x1 + COLS * g.fs, g.y2];
        const pos = JSON.stringify(Object.assign({}, g.pos, { rects: [rect] }));
        let changed = false;
        if (pos !== item.annotationPosition) { item.annotationPosition = pos; changed = true; }
        const marked = this.mark(comment);
        if (marked !== (item.annotationComment || '')) { item.annotationComment = marked; changed = true; }
        if (!item.hasTag(TAG_TEXT)) { item.addTag(TAG_TEXT); changed = true; }
        if (tagRows !== rows) {
          if (rowTag) item.removeTag(rowTag.tag);
          item.addTag(TAG_ROWS + rows); changed = true;
        }
        this.state[item.key] = { comment, h: Math.round(rows * g.rowH * 10) };
        if (changed) { await item.saveTx(); delete this.rowsLive[item.key]; this.injectAll(); this.log('snapped rows=' + rows + ' dragged=' + !!dragged + ' lines=' + lines); }
      } catch (e) {
        this.log('ERROR ' + e + ' ' + e.stack);
      } finally { this.busy = false; }
    },

    // 等比缩放：改字号，左上角不动，行数不变
    async setSize(item, fs) {
      if (this.busy) return;
      this.busy = true;
      try {
        const g = this.geom(item);
        const t = item.getTags().find(t => t.tag.startsWith(TAG_ROWS));
        const rows = t ? parseInt(t.tag.slice(TAG_ROWS.length)) : Math.max(1, Math.round((g.y2 - g.y1) / g.rowH));
        const rect = [g.x1, g.y2 - rows * fs * LINE_H, g.x1 + COLS * fs, g.y2];
        item.annotationPosition = JSON.stringify(Object.assign({}, g.pos, { fontSize: fs, rects: [rect] }));
        if (!item.hasTag(TAG_TEXT)) item.addTag(TAG_TEXT);
        await item.saveTx();
        Zotero.Prefs.set(PREF_SIZE, fs, true);
        delete this.rowsLive[item.key];
        this.state[item.key] = { comment: this.toFull(item.annotationComment || ''), h: Math.round(rows * fs * LINE_H * 10) };
        this.injectAll();
      } catch (e) { this.log('setSize ERROR ' + e); } finally { this.busy = false; }
    },

    // 步进：dir=+1 放大，-1 缩小；作用于当前选中的格子批注
    async stepSelected(reader, dir) {
      const ids = (reader._internalReader._state.selectedAnnotationIDs) || [];
      for (const key of ids) {
        const it = Zotero.Items.getByLibraryAndKey(reader._item.libraryID, key);
        if (!it || it.annotationType !== 'text') continue;
        const cur = this.geom(it).fs;
        let i = SIZES.reduce((b, v, j) => Math.abs(v - cur) < Math.abs(SIZES[b] - cur) ? j : b, 0);
        i = Math.min(SIZES.length - 1, Math.max(0, i - dir));
        await this.setSize(it, SIZES[i]);
      }
    },

    async createGrid(reader, rows) {
      this.log('createGrid begin');
      const att = reader._item;
      const saved = Zotero.Prefs.get(PREF_SIZE, true);
      const fs = SIZES.includes(saved) ? saved : SIZES[0];
      let pageIndex = 0, view = [0, 0, 595, 842], x1 = 40, y2 = view[3] - 60;
      try {
        const win = reader._internalReader._primaryView._iframeWindow;
        const app = win.PDFViewerApplication || (win.wrappedJSObject && win.wrappedJSObject.PDFViewerApplication);
        const pv = app.pdfViewer;
        pageIndex = pv.currentPageNumber - 1;
        const pageView = pv.getPageView(pageIndex);
        view = Array.from(pageView.pdfPage.view);
        // 当前屏幕可见区域的左上角 -> PDF 坐标
        const cont = win.document.getElementById('viewerContainer');
        const top = Math.max(0, cont.getBoundingClientRect().top - pageView.div.getBoundingClientRect().top);
        const [px, py] = pageView.viewport.convertToPdfPoint(40, top + 30);
        x1 = Math.min(Math.max(view[0] + 10, px), view[2] - COLS * fs - 10);
        y2 = Math.min(py, view[3] - 10);
        this.log('page ' + pageIndex + ' scrollTop ' + top + ' pos ' + x1 + ',' + y2);
      } catch (e) {
        this.log('page lookup failed ' + e);
        y2 = view[3] - 60;
      }
      const rect = [x1, y2 - rows * fs * LINE_H, x1 + COLS * fs, y2];
      const pad = n => String(n).padStart(5, '0');
      const text = new Zotero.Item('annotation');
      text.libraryID = att.libraryID;
      text.parentID = att.id;
      text.annotationType = 'text';
      text.annotationColor = '#000000';
      text.annotationPageLabel = String(pageIndex + 1);
      text.annotationSortIndex = pad(pageIndex) + '|000000|' + pad(Math.max(0, Math.round(view[3] - y2)));
      text.annotationPosition = JSON.stringify({ pageIndex, fontSize: fs, rotation: 0, rects: [rect] });
      text.annotationComment = '';
      text.addTag(TAG_TEXT);
      text.addTag(TAG_ROWS + rows);
      await text.saveTx();
      this.log('created ' + text.key);
    },

    // 向阅读器页面注入按钮和格子样式
    inject(reader) {
      const doc = reader._iframeWindow && reader._iframeWindow.document;
      const anchor = doc && doc.querySelector('button.toolbar-button.text');
      if (anchor && !doc.getElementById('gridbox-btn')) {
        const b = doc.createElement('button');
        b.id = 'gridbox-btn';
        b.tabIndex = -1;
        b.className = 'toolbar-button';
        b.title = '插入稿纸格子 (25列)';
        const NS = 'http://www.w3.org/2000/svg';
        const svg = doc.createElementNS(NS, 'svg');
        svg.setAttribute('width', '16');
        svg.setAttribute('height', '16');
        svg.setAttribute('viewBox', '0 0 16 16');
        const p = doc.createElementNS(NS, 'path');
        p.setAttribute('d', 'M2 2h12v12H2z M2 6h12 M2 10h12 M6 2v12 M10 2v12');
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke', 'currentColor');
        p.setAttribute('stroke-width', '1.2');
        svg.appendChild(p);
        b.appendChild(svg);
        b.addEventListener('click', () => {
          this.log('button clicked');
          this.createGrid(reader, 4).catch(e => this.log('ERROR ' + e + ' ' + e.stack));
        });
        const mk = (id, label, title, dir) => {
          const x = doc.createElement('button');
          x.id = id; x.tabIndex = -1; x.className = 'toolbar-button'; x.title = title;
          x.textContent = label; x.style.cssText = 'font-size:12px;font-weight:bold;';
          x.addEventListener('click', () => this.stepSelected(reader, dir).catch(e => this.log('ERROR ' + e)));
          return x;
        };
        const up = mk('gridbox-up', 'A+', '放大选中的格子', +1), down = mk('gridbox-down', 'A-', '缩小选中的格子', -1);
        anchor.insertAdjacentElement('afterend', b);
        b.insertAdjacentElement('afterend', up);
        up.insertAdjacentElement('afterend', down);
        this.log('button injected');
      }
      // 格子样式：只作用于带标签的文字批注
      try {
        const views = [reader._internalReader._primaryView, reader._internalReader._secondaryView].filter(Boolean);
        const keys = this.gridKeys(reader);
        const hl = (n) => { const L = []; for (let r = 1; r <= n; r++) L.push('linear-gradient(' + GRID_COLOR + ',' + GRID_COLOR + ') 0 calc(' + (r * LINE_H) + 'em - 1px) / 100% 1px no-repeat'); return L; };
        const bg = k => ['linear-gradient(to left,' + GRID_COLOR + ' 1px,transparent 1px) 0 0 / 1em 100% repeat-x'].concat(hl(k.rows)).join(',');
        const rule = k => '.textAnnotation[data-id="' + k.key + '"]{background:' + bg(k) + ' !important;height:calc(' + (k.rows * LINE_H) + 'em) !important;width:25.05em !important;min-height:0 !important;min-width:0 !important;}';
        const sel = keys.map(k => '.textAnnotation[data-id="' + k.key + '"]').join(',');
        const css = keys.length ? sel + '{padding:0 !important;margin:0;text-rendering:geometricPrecision !important;font-kerning:none;font-variant-ligatures:none;line-height:' + LINE_H + ' !important;letter-spacing:0 !important;'
          + 'caret-color:transparent !important;white-space:pre-wrap !important;overflow-wrap:anywhere !important;word-break:break-all !important;line-break:anywhere;'
          + 'text-align:left;background-color:transparent;'
          + 'box-shadow:inset 1px 0 0 ' + GRID_COLOR + ',inset 0 1px 0 ' + GRID_COLOR + ';}'
          + keys.map(rule).join('') : '';
        for (const v of views) {
          const d = v._iframeWindow.document;
          let st = d.getElementById('gridbox-style');
          if (!st) { st = d.createElement('style'); st.id = 'gridbox-style'; d.head.appendChild(st); }
          if (st.textContent !== css) st.textContent = css;
          this.hookTextareas(d);
          const act = d.activeElement; if (act && act.classList && act.classList.contains('textAnnotation')) this.updateCursor(act);
        }
      } catch (e) { this.log('style ERROR ' + e); }
    },

    gridKeys(reader) {
      return reader._item.getAnnotations().filter(a => a.annotationType === 'text' && a.hasTag(TAG_TEXT)).map(a => {
        const t = a.getTags().find(t => t.tag.startsWith(TAG_ROWS));
        const rows = t ? parseInt(t.tag.slice(TAG_ROWS.length)) : 1;
        return { key: a.key, rows: Math.max(rows, this.rowsLive[a.key] || 0) };
      });
    },

    updateCursor(ta) {
      const d = ta.ownerDocument;
      if (d.activeElement !== ta) return;
      if (!ta.__gbc) {
        const c = d.createElement('div');
        c.style.cssText = 'position:absolute;pointer-events:none;background:rgba(80,140,255,0.45);display:none;';
        ta.parentNode.insertBefore(c, ta);
        ta.__gbc = c;
      }
      const c = ta.__gbc;
      const fs = parseFloat(d.defaultView.getComputedStyle(ta).fontSize);
      const chars = Array.from(ta.value.slice(0, ta.selectionStart)).filter(c => c !== String.fromCharCode(0x200B));
      let row = 0, col = 0;
      for (const ch of chars) {
        if (ch === String.fromCharCode(10)) { row++; col = 0; continue; }
        col++;
        if (col >= COLS) { row++; col = 0; }
      }
      c.style.left = (ta.offsetLeft + col * fs) + 'px';
      c.style.top = (ta.offsetTop + row * fs * LINE_H) + 'px';
      c.style.width = fs + 'px';
      c.style.height = (fs * LINE_H) + 'px';
      c.style.display = 'block';
    },

    // 对输入框：实时转全角(输入法组合期间跳过)
    hookTextareas(d) {
      for (const ta of d.querySelectorAll('.textAnnotation')) {
        if (ta.__gb) continue;
        ta.__gb = true;
        const conv = () => {
          const v = this.mark(this.toFull(ta.value));
          if (v !== ta.value) {
            const n = Array.from(ta.value.slice(0, ta.selectionStart)).filter(c => c !== String.fromCharCode(0x200B)).length;
            ta.value = v;
            let p = 0, seen = 0;
            while (p < v.length && seen < n) { if (v[p] !== String.fromCharCode(0x200B)) seen++; p++; }
            if (p === 0 && v.length) p = 1;
            ta.setSelectionRange(p, p);
            ta.dispatchEvent(new d.defaultView.InputEvent('input', { bubbles: true, inputType: 'insertText' }));
          }
        };
        ta.addEventListener('input', e => { if (!e.isComposing) conv(); }, true);
        const live = () => {
          const key = ta.getAttribute('data-id');
          const lines = this.toFull(ta.value).split(String.fromCharCode(10)).reduce((n, l) => n + Math.max(1, Math.ceil(Array.from(l).length / COLS)), 0);
          if (lines > (this.rowsLive[key] || 0)) { this.rowsLive[key] = lines; this.injectAll(); }
        };
        ta.addEventListener('input', live, true);
        // Tab = 空两格（两个全角空格），并阻止焦点跳走
        ta.addEventListener('keydown', e => {
          if (e.key !== 'Tab' || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
          e.preventDefault(); e.stopPropagation();
          const sp = String.fromCharCode(0x3000).repeat(2);
          const a = ta.selectionStart, b = ta.selectionEnd;
          ta.value = ta.value.slice(0, a) + sp + ta.value.slice(b);
          ta.setSelectionRange(a + 2, a + 2);
          ta.dispatchEvent(new d.defaultView.Event('input', { bubbles: true }));
        }, true);
        // compositionend 不触发 conv，改为全靠 input(isComposing=false) 兜底
        const upd = () => this.updateCursor(ta);
        try { new d.defaultView.ResizeObserver(() => upd()).observe(ta); } catch (e) {}
        for (const ev of ['input', 'keyup', 'keydown', 'click', 'focus', 'select', 'compositionupdate', 'compositionend']) ta.addEventListener(ev, () => setTimeout(upd, 0), true);
        ta.addEventListener('blur', () => { if (ta.__gbc) ta.__gbc.style.display = 'none'; }, true);
        d.addEventListener('selectionchange', () => { if (d.activeElement === ta) upd(); });
      }
    },

    injectAll() {
      try { for (const r of Zotero.Reader._readers) this.inject(r); } catch (e) { this.log('injectAll ERROR ' + e); }
    },

    addToUI() {
      const type = 'createAnnotationContextMenu';
      const handler = event => {
        const { reader, params, append } = event;
        SIZES.forEach((fs, i) => append({
          label: '格子大小：' + SIZE_NAMES[i],
          onCommand: async () => {
            for (const key of params.ids) {
              const it = Zotero.Items.getByLibraryAndKey(reader._item.libraryID, key);
              if (it && it.annotationType === 'text') await GridBox.setSize(it, fs);
            }
          },
        }));
        append({
          label: '转为稿纸格子 (25列)',
          onCommand: async () => {
            for (const key of params.ids) {
              const it = Zotero.Items.getByLibraryAndKey(reader._item.libraryID, key);
              if (it && it.annotationType === 'text') await GridBox.snap(it, null);
            }
            GridBox.injectAll();
          },
        });
      };
      Zotero.Reader.registerEventListener(type, handler, id);
      this.handlers.push([type, handler]);

      this.tabObserverID = Zotero.Notifier.registerObserver({
        notify: () => { setTimeout(() => this.injectAll(), 800); setTimeout(() => this.injectAll(), 2500); },
      }, ['tab'], 'gridbox-tab');
      this.injectTimer = setInterval(() => this.injectAll(), 1500);

      this.observerID = Zotero.Notifier.registerObserver({
        notify: async (event, type, ids) => {
          if (!AUTO_SNAP || event !== 'modify' || this.busy) return;
          for (const itemID of ids) {
            const it = Zotero.Items.get(itemID);
            if (!it || !it.isAnnotation() || it.annotationType !== 'text' || !it.hasTag(TAG_TEXT)) continue;
            await this.snap(it, null);
          }
        },
      }, ['item'], 'gridbox');
    },

    removeFromUI() {
      for (const [type, handler] of this.handlers) Zotero.Reader.unregisterEventListener(type, handler);
      this.handlers = [];
      if (this.tabObserverID) Zotero.Notifier.unregisterObserver(this.tabObserverID);
      if (this.observerID) Zotero.Notifier.unregisterObserver(this.observerID);
      clearInterval(this.injectTimer);
      try {
        for (const r of Zotero.Reader._readers) {
          for (const n of ['gridbox-btn', 'gridbox-up', 'gridbox-down']) { const e = r._iframeWindow.document.getElementById(n); if (e) e.remove(); }
          for (const v of [r._internalReader._primaryView, r._internalReader._secondaryView]) {
            const s = v && v._iframeWindow.document.getElementById('gridbox-style'); if (s) s.remove();
          }
        }
      } catch (e) {}
    },
  };
  GridBox.addToUI();
  GridBox.log('started ' + version);
}

function shutdown() { if (GridBox) { GridBox.removeFromUI(); GridBox = undefined; } }
