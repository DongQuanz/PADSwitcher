'use strict';
// PADSwitcher phone remote. Every request is signed with the secret from the QR code;
// the secret itself is never sent to the computer.
(() => {
  const $ = s => document.querySelector(s);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const random = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
  const isClaude = id => String(id || '').startsWith('claude:');
  const TITLES = { sessions:'Session', quota:'Quota', kaggle:'Kaggle' };
  let secret = null, device = null, events = null, retry = 0, retryTimer = null;
  let overview = null, threads = [], threadCursor = null, search = '', tab = 'sessions';
  let provider = store.get('pad-provider') || 'all';
  let view = null;          // the open session: {id, thread, nextCursor}
  let newProvider = 'codex', folderChoice = null;
  const approvals = new Map();
  const buffers = new Map();

  // ---------- pairing ----------
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('k')) {
    const k = hash.get('k');
    // Keep this phone's id when its code was only erased, so the computer still knows it.
    const stored = store.get('pad-secret');
    if (stored && k !== stored) store.del('pad-device');
    store.set('pad-secret', k); secret = k;
    history.replaceState(null, '', location.pathname);
  }
  secret = store.get('pad-secret') || secret;
  device = store.get('pad-device');
  if (!device) { device = random(16); store.set('pad-device', device); }
  // Another tab scanned a new code: this tab switches to it instead of failing on the old one.
  window.addEventListener('storage', e => { if (e.key === 'pad-secret' && e.newValue && e.newValue !== secret) location.reload(); });

  // ---------- transport ----------
  class RemoteError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }
  async function call(cmd, args = {}) {
    if (!secret) throw new RemoteError('Chưa ghép nối.', 403);
    const body = JSON.stringify({ cmd, args, d: device, t: Date.now(), n: random(12) });
    let response;
    try {
      response = await fetch('/api/call', { method:'POST', headers:{ 'Content-Type':'application/json', 'X-Pad-Signature': padHmac.hmac(secret, 'POST\n/api/call\n' + body) }, body, cache:'no-store' });
    } catch { throw new RemoteError('Không kết nối được máy tính. Kiểm tra Wi-Fi và PADSwitcher.', 0); }
    let data = {}; try { data = await response.json(); } catch {}
    if (!response.ok) throw new RemoteError(data.error || 'Máy tính từ chối yêu cầu.', response.status);
    if (!data.ok) throw new RemoteError(data.error || 'Thao tác chưa thực hiện được.', 200, data.code);
    return data.result;
  }
  // A tab left open with an old code must not erase the code another tab has just scanned.
  function forgetSecret() { if (store.get('pad-secret') === secret) store.del('pad-secret'); secret = null; }
  function authFailure(error) {
    if (error.status === 403) { forgetSecret(); showPair('Mã kết nối đã đổi. Quét lại mã QR mới trên PADSwitcher.'); return true; }
    if (error.status === 409) { showPair(error.message); return true; }
    return false;
  }
  function connectEvents() {
    clearTimeout(retryTimer); events?.close();
    const t = Date.now(), n = random(12), s = padHmac.hmac(secret, ['GET', '/api/events', device, t, n].join('\n'));
    const source = events = new EventSource(`/api/events?d=${encodeURIComponent(device)}&t=${t}&n=${n}&s=${s}`);
    source.onopen = () => { retry = 0; setLink('ready'); };
    source.onerror = () => { source.close(); if (events === source) { events = null; setLink('waiting', 'Đang kết nối lại'); scheduleReconnect(); } };
    source.addEventListener('overview', e => { overview = JSON.parse(e.data); setLink('ready'); renderQuota(); renderKaggle(); renderNotices(); });
    source.addEventListener('approval', e => {
      const a = JSON.parse(e.data), known = approvals.has(a.id); approvals.set(a.id, a); renderApprovals();
      if (!known && a.answerable) { navigator.vibrate?.(200); toast((a.provider === 'claude' ? 'Claude' : 'Codex') + ' cần bạn duyệt một thao tác.'); }
    });
    source.addEventListener('approvalResolved', e => { approvals.delete(JSON.parse(e.data).id); renderApprovals(); });
    source.addEventListener('live', e => onLive(JSON.parse(e.data)));
    source.addEventListener('kaggle', e => {
      const k = JSON.parse(e.data), ok = k.status === 'complete';
      navigator.vibrate?.(ok ? 120 : [120, 80, 120]);
      toast(`Kaggle: ${k.title} ${ok ? 'đã chạy xong' : k.status === 'error' ? 'bị lỗi' : 'đã dừng'}.`, !ok);
      if (tab !== 'kaggle') $('#kaggle-badge').classList.remove('hidden');
    });
    source.addEventListener('kicked', () => { source.close(); events = null; forgetSecret(); showPair('Máy tính đã tạo mã mới. Quét lại mã QR để tiếp tục.'); });
  }
  function scheduleReconnect() {
    clearTimeout(retryTimer);
    const wait = Math.min(15000, 1000 * 2 ** retry++);
    retryTimer = setTimeout(async () => {
      try { await call('hello'); connectEvents(); if (view) openThread(view.id, true); else loadThreads(); }
      catch (error) { if (!authFailure(error)) { setLink('', error.status === 0 ? 'Mất kết nối' : error.message); scheduleReconnect(); } }
    }, wait);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !secret) return;
    if (!events || events.readyState === EventSource.CLOSED) { retry = 0; scheduleReconnect(); }
    else if (view) openThread(view.id, true);
  });

  // ---------- helpers ----------
  function setLink(state, text) {
    $('#link-dot').className = 'dot ' + (state || '');
    $('#link-text').textContent = text || (state === 'ready' ? 'Trực tuyến' : 'Đang kết nối');
  }
  let toastTimer;
  function toast(text, bad = false) {
    const el = $('#toast'); el.textContent = text; el.className = 'toast' + (bad ? ' bad' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), bad ? 5000 : 2600);
  }
  const fail = error => { if (!authFailure(error)) toast(error.message, true); };
  async function busy(button, task) {
    if (button.disabled) return; button.disabled = true;
    try { return await task(); } catch (error) { fail(error); } finally { button.disabled = false; }
  }
  function ago(seconds) {
    if (!seconds) return '';
    const d = Date.now() / 1000 - seconds;
    if (d < 60) return 'vừa xong';
    if (d < 3600) return Math.floor(d / 60) + ' phút trước';
    if (d < 86400) return Math.floor(d / 3600) + ' giờ trước';
    if (d < 7 * 86400) return Math.floor(d / 86400) + ' ngày trước';
    return new Date(seconds * 1000).toLocaleDateString('vi-VN');
  }
  function until(seconds) {
    if (!seconds) return '';
    const d = seconds - Date.now() / 1000;
    if (d <= 0) return 'đã đặt lại';
    if (d < 3600) return 'còn ' + Math.max(1, Math.round(d / 60)) + ' phút';
    if (d < 86400) return 'còn ' + Math.floor(d / 3600) + ' giờ ' + Math.floor(d % 3600 / 60) + ' phút';
    return 'còn ' + Math.floor(d / 86400) + ' ngày ' + Math.floor(d % 86400 / 3600) + ' giờ';
  }
  const folderName = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';
  const glyph = name => `<span class="glyph ${name}" aria-hidden="true"></span>`;
  const tile = name => `<span class="tile ${name}">${glyph(name)}</span>`;
  function markdown(text) {
    let out = '';
    String(text || '').split('```').forEach((part, i) => {
      if (i % 2) { const nl = part.indexOf('\n'); out += '<pre><code>' + esc((nl >= 0 ? part.slice(nl + 1) : part).replace(/\n$/, '')) + '</code></pre>'; return; }
      for (const para of part.split(/\n{2,}/)) {
        if (!para.trim()) continue;
        const html = esc(para.replace(/^\n+|\n+$/g, ''))
          .replace(/`([^`\n]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
          .replace(/^#{1,6} (.*)$/gm, '<b>$1</b>')
          .replace(/^[-*] /gm, '• ');
        out += '<p>' + html + '</p>';
      }
    });
    return out;
  }
  // A ring shows what is left; the CSP forbids inline styles, so geometry uses SVG attributes.
  function ring(left, label, detail) {
    const r = 25, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, left));
    const cls = v <= 0 ? 'empty' : v < 20 ? 'low' : '';
    return `<div class="gauge"><div class="ring-wrap"><svg class="ring" viewBox="0 0 58 58" aria-hidden="true"><circle class="track" cx="29" cy="29" r="${r}"/><circle class="value ${cls}" cx="29" cy="29" r="${r}" stroke-dasharray="${(v / 100 * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 29 29)"/></svg><span class="ring-num">${Math.round(v)}%</span></div><div class="gauge-text"><b>${esc(label)}</b><small>${esc(detail)}</small></div></div>`;
  }

  // ---------- screens ----------
  function showPair(message) {
    events?.close(); events = null; clearTimeout(retryTimer);
    for (const id of ['#sessions-screen', '#quota-screen', '#kaggle-screen', '#thread-screen', '#new-screen', '#tabs']) $(id).classList.add('hidden');
    $('#pair-screen').classList.remove('hidden'); $('#page-title').textContent = 'Ghép nối';
    if (message) $('#pair-message').textContent = message;
    setLink('', 'Chưa ghép nối');
  }
  function showTab(next) {
    tab = next;
    $('#pair-screen').classList.add('hidden'); $('#tabs').classList.remove('hidden');
    for (const name of ['sessions', 'quota', 'kaggle']) $('#' + name + '-screen').classList.toggle('hidden', tab !== name);
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $('#page-title').textContent = TITLES[tab];
    if (tab === 'quota') renderQuota();
    if (tab === 'kaggle') { $('#kaggle-badge').classList.add('hidden'); renderKaggle(); }
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.tab').forEach(b => b.onclick = () => showTab(b.dataset.tab));

  // ---------- sessions ----------
  let lastNotices = [];
  function renderNotices() {
    const notes = lastNotices.slice();
    const g = overview?.gateway;
    if (g && g.status !== 'ready' && provider !== 'claude' && !notes.some(n => n.provider === 'codex')) notes.push({ provider:'codex', message:'Kết nối Codex đang tắt trên máy tính. Chọn một tài khoản và bấm “Dùng tài khoản này” để bật.' });
    $('#notices').innerHTML = notes.map(n => `<div class="notice">${n.provider === 'claude' ? 'Claude' : 'Codex'}: ${esc(n.message)}</div>`).join('');
  }
  const statusPill = t => {
    if (t.waiting?.includes('waitingOnApproval') || [...approvals.values()].some(a => a.threadId === t.id)) return '<span class="pill warn">Chờ duyệt</span>';
    if (t.status === 'active') return '<span class="pill live"><span class="dot active"></span>Đang chạy</span>';
    if (t.status === 'systemError') return '<span class="pill bad">Lỗi</span>';
    return '';
  };
  function renderThreads() {
    const list = $('#thread-list');
    if (!threads.length) list.innerHTML = '<li class="empty">' + (search ? 'Không có session phù hợp.' : 'Chưa có session nào.') + '</li>';
    else list.innerHTML = threads.map(t => {
      const kind = t.provider === 'claude' ? 'claude' : 'codex';
      return `<li><button class="row" data-thread="${esc(t.id)}">${tile(kind)}<div class="row-body"><div class="row-top"><span class="row-title">${esc(t.title || 'Session chưa có tiêu đề')}</span>${statusPill(t)}</div><div class="row-meta"><span>${esc(folderName(t.cwd))}</span>${t.branch ? `<span>${esc(t.branch)}</span>` : ''}<span>${esc(ago(t.updatedAt))}</span></div>${t.openElsewhere ? `<span class="tag">Đang mở trong ${esc(t.openElsewhere)}</span>` : ''}</div></button></li>`;
    }).join('');
    list.querySelectorAll('[data-thread]').forEach(b => b.onclick = () => openThread(b.dataset.thread));
    $('#threads-more').classList.toggle('hidden', !threadCursor);
  }
  let threadsFlight = null;
  async function loadThreads(append = false) {
    if (threadsFlight) return threadsFlight;
    threadsFlight = (async () => {
      try {
        const r = await call('threads', { search, provider, cursor: append ? threadCursor : null });
        threads = append ? threads.concat(r.threads) : r.threads; threadCursor = r.nextCursor;
        if (!append) lastNotices = r.notices || [];
        renderThreads(); renderNotices();
      } catch (error) {
        if (authFailure(error)) return;
        if (!append) { threads = []; $('#thread-list').innerHTML = `<li class="empty">${esc(error.message)}</li>`; }
        else toast(error.message, true);
      } finally { threadsFlight = null; }
    })();
    return threadsFlight;
  }
  function setProvider(next) {
    provider = next; store.set('pad-provider', next);
    document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.provider === next));
    threadCursor = null; loadThreads();
  }
  document.querySelectorAll('.chip').forEach(c => c.onclick = () => setProvider(c.dataset.provider));
  let searchTimer;
  $('#search').oninput = e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { search = e.target.value.trim(); loadThreads(); }, 350); };
  $('#threads-more').onclick = () => loadThreads(true);
  setInterval(() => { if (secret && document.visibilityState === 'visible' && tab === 'sessions' && !view && !$('#tabs').classList.contains('hidden')) loadThreads(); }, 20000);
  let listRefresh;
  const refreshListSoon = () => { clearTimeout(listRefresh); listRefresh = setTimeout(() => { if (!view) loadThreads(); }, 1200); };

  // ---------- one session ----------
  function stepHtml(item) {
    switch (item.type) {
      case 'user': return `<div class="msg user">${esc(item.text)}${item.attachments ? `\n<small>+ ${item.attachments} tệp đính kèm</small>` : ''}</div>`;
      case 'agent': return `<div class="msg agent">${markdown(item.text) || '<p class="muted">…</p>'}</div>`;
      case 'reasoning': return item.text ? `<details class="step"><summary><span class="step-kind">Suy nghĩ</span></summary><pre>${esc(item.text)}</pre></details>` : '';
      case 'plan': return `<details class="step" open><summary><span class="step-kind">Kế hoạch</span></summary><pre>${esc(item.text)}</pre></details>`;
      case 'command': {
        const state = item.status === 'inProgress' ? '<span class="dot active"></span>' : item.status === 'interrupted' ? '<span class="pill">Dừng</span>' : item.exitCode === 0 ? '<span class="pill good">0</span>' : item.exitCode != null ? `<span class="pill bad">${esc(item.exitCode)}</span>` : item.status === 'declined' ? '<span class="pill warn">Từ chối</span>' : '';
        return `<details class="step"><summary><span class="step-kind">$</span><code>${esc(item.command)}</code>${state}</summary>${item.output ? `<pre>${esc(item.output)}</pre>` : ''}</details>`;
      }
      case 'files': return `<details class="step"><summary><span class="step-kind">Sửa ${item.changes.length} tệp</span>${item.status === 'inProgress' ? '<span class="dot active"></span>' : item.status === 'declined' || item.status === 'failed' ? '<span class="pill warn">Không áp dụng</span>' : ''}</summary><ul class="files">${item.changes.map(c => `<li>${esc(c.kind === 'add' ? '+ ' : c.kind === 'delete' ? '− ' : '')}${esc(c.path)}</li>`).join('')}</ul></details>`;
      case 'tool': return `<details class="step"><summary><span class="step-kind">Công cụ</span><code>${esc(item.name)}</code>${item.status === 'inProgress' ? '<span class="dot active"></span>' : ''}</summary></details>`;
      case 'search': return `<details class="step"><summary><span class="step-kind">Tìm web</span><code>${esc(item.query)}</code></summary></details>`;
      case 'note': return `<div class="note">${esc(item.text)}</div>`;
      default: return '';
    }
  }
  function turnFoot(turn) {
    if (turn.status === 'inProgress') return '';
    if (turn.status === 'failed') return `<div class="turn-foot bad">Lỗi: ${esc(turn.error || 'lượt này dừng giữa chừng.')}</div>`;
    if (turn.status === 'interrupted') return '<div class="turn-foot">Đã dừng</div>';
    return turn.durationMs ? `<div class="turn-foot">Xong trong ${Math.max(1, Math.round(turn.durationMs / 1000))} giây</div>` : '';
  }
  function turnEl(turn) {
    const el = document.createElement('div'); el.className = 'turn'; el.dataset.turn = turn.id || '';
    el.innerHTML = '<div class="items"></div><div class="foot"></div>';
    for (const item of turn.items || []) putItem(el, item);
    el.querySelector('.foot').innerHTML = turnFoot(turn);
    return el;
  }
  function findTurn(id, create) {
    let el = [...$('#turns').children].find(c => c.dataset.turn === id);
    if (!el && create) { $('#turns').querySelector('.empty')?.remove(); el = turnEl({ id, status:'inProgress', items:[] }); $('#turns').append(el); }
    return el;
  }
  function putItem(turnElement, item) {
    if (!item.id) return;
    const holder = turnElement.querySelector('.items');
    let el = [...holder.children].find(c => c.dataset.item === item.id);
    if (!el) { el = document.createElement('div'); el.dataset.item = item.id; holder.append(el); }
    const open = el.querySelector('details')?.open;
    el.innerHTML = stepHtml(item); if (open) el.querySelector('details')?.setAttribute('open', '');
  }
  const nearBottom = () => { const f = $('#feed'); return f.scrollHeight - f.scrollTop - f.clientHeight < 160; };
  const toBottom = () => { const f = $('#feed'); f.scrollTop = f.scrollHeight; };
  function setThreadStatus(status) {
    if (!view) return;
    view.thread.status = status;
    const waiting = [...approvals.values()].some(a => a.threadId === view.id);
    const pill = $('#thread-status');
    pill.className = 'pill ' + (waiting ? 'warn' : status === 'active' ? 'live' : status === 'systemError' ? 'bad' : '');
    pill.innerHTML = waiting ? 'Chờ duyệt' : status === 'active' ? '<span class="dot active"></span>Đang chạy' : status === 'systemError' ? 'Lỗi' : '';
    const running = status === 'active', elsewhere = view.thread.openElsewhere;
    // A Claude session busy in another app can only be watched from here.
    $('#stop-turn').classList.toggle('hidden', !running || !!elsewhere);
    $('#send').classList.toggle('hidden', running);
    const banner = $('#thread-banner');
    banner.textContent = elsewhere ? (running ? `Session đang chạy trong ${elsewhere}. Điện thoại chỉ theo dõi; dừng nó trên máy tính.` : `Session đang mở trong ${elsewhere}. Tin nhắn từ điện thoại sẽ tạo một nhánh mới để không ghi chồng.`) : '';
    banner.classList.toggle('hidden', !elsewhere);
    $('#prompt').placeholder = elsewhere ? 'Nhắn trong nhánh mới' : view.thread.provider === 'claude' ? 'Nhắn tiếp cho Claude' : 'Nhắn tiếp cho Codex';
  }
  let pollTimer = null;
  function schedulePoll() {
    clearTimeout(pollTimer);
    // Sessions running elsewhere send no live events; reread them while they run.
    if (view && view.thread.openElsewhere && view.thread.status === 'active') pollTimer = setTimeout(() => { if (view && document.visibilityState === 'visible') openThread(view.id, true); }, 4000);
  }
  async function openThread(id, quiet = false) {
    const fromList = threads.find(t => t.id === id);
    if (!quiet || !view || view.id !== id) {
      view = { id, thread: fromList || { id, status:null, provider: isClaude(id) ? 'claude' : 'codex' }, nextCursor:null };
      $('#thread-glyph').className = 'glyph ' + (isClaude(id) ? 'claude' : 'codex');
      $('#thread-title').textContent = fromList?.title || 'Session';
      $('#thread-sub').textContent = fromList?.cwd || '';
      $('#turns').innerHTML = '<div class="empty">Đang tải…</div>'; $('#approvals').innerHTML = '';
      $('#feed-more').classList.add('hidden');
      $('#thread-screen').classList.remove('hidden');
      setThreadStatus(fromList?.status);
    }
    try {
      const stick = !quiet || nearBottom();
      const r = await call('thread', { threadId:id });
      if (!view || view.id !== id) return;
      view.thread = r.thread; view.nextCursor = r.nextCursor;
      for (const a of r.approvals) approvals.set(a.id, a);
      $('#thread-title').textContent = r.thread.title || 'Session';
      $('#thread-sub').textContent = [folderName(r.thread.cwd), r.thread.branch, r.thread.mode].filter(Boolean).join(' · ');
      const turns = $('#turns'); turns.innerHTML = '';
      if (!r.turns.length) turns.innerHTML = '<div class="empty">Session chưa có lượt nào.</div>';
      for (const t of r.turns) turns.append(turnEl(t));
      $('#feed-more').classList.toggle('hidden', !r.nextCursor);
      setThreadStatus(r.thread.status); renderApprovals(); if (stick) toBottom();
      schedulePoll();
    } catch (error) { if (!authFailure(error) && !quiet) $('#turns').innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
  }
  $('#feed-more').onclick = e => busy(e.currentTarget, async () => {
    const r = await call('more', { threadId:view.id, cursor:view.nextCursor });
    const turns = $('#turns'), f = $('#feed'), before = f.scrollHeight;
    for (const t of r.turns.slice().reverse()) if (!findTurn(t.id)) turns.prepend(turnEl(t));
    view.nextCursor = r.nextCursor; $('#feed-more').classList.toggle('hidden', !r.nextCursor);
    f.scrollTop += f.scrollHeight - before;
  });
  $('#thread-back').onclick = () => { view = null; clearTimeout(pollTimer); $('#thread-screen').classList.add('hidden'); loadThreads(); };

  function onLive(e) {
    if (e.method === 'bridge/closed') { if (view && !isClaude(view.id)) setTimeout(() => view && openThread(view.id, true), 1500); return; }
    if (e.method === 'thread/status/changed' || e.method === 'turn/completed') refreshListSoon();
    if (!view || e.threadId !== view.id) return;
    const stick = nearBottom();
    switch (e.method) {
      case 'turn/started': {
        const el = findTurn(e.turn.id, true); for (const item of e.turn.items || []) putItem(el, item);
        setThreadStatus('active'); break;
      }
      case 'turn/completed': {
        const el = findTurn(e.turn.id, true);
        for (const item of e.turn.items || []) putItem(el, item);
        el.querySelector('.foot').innerHTML = turnFoot(e.turn);
        break;
      }
      case 'item/started': case 'item/completed': {
        const el = findTurn(e.turnId, true);
        if (e.item.type === 'agent') { if (e.method === 'item/completed') buffers.delete(e.item.id); else if (!e.item.text) e.item.text = buffers.get(e.item.id) || ''; }
        putItem(el, e.item); break;
      }
      case 'item/agentMessage/delta': {
        const text = (buffers.get(e.itemId) || '') + e.delta; buffers.set(e.itemId, text);
        putItem(findTurn(e.turnId, true), { id:e.itemId, type:'agent', text }); break;
      }
      case 'thread/status/changed': setThreadStatus(e.status); break;
      case 'error': if (!e.willRetry) toast(e.message, true); break;
    }
    if (stick) toBottom();
  }

  // ---------- approvals ----------
  function approvalHtml(a) {
    const who = a.provider === 'claude' ? 'Claude' : 'Codex';
    const title = a.kind === 'command' ? `${who} muốn chạy lệnh` : a.kind === 'files' ? `${who} muốn sửa tệp` : a.tool ? `${who} muốn dùng ${a.tool}` : `${who} cần bạn trả lời`;
    const body = (a.command ? `<pre>${esc(a.command)}</pre>` : '') + (a.files?.length ? `<pre>${a.files.map(esc).join('\n')}</pre>` : '') + (a.cwd ? `<p class="muted">Trong ${esc(a.cwd)}</p>` : '') + (a.reason ? `<p>${esc(a.reason)}</p>` : '') + (a.grantRoot ? `<p>Xin quyền ghi trong <b>${esc(a.grantRoot)}</b></p>` : '');
    const always = a.provider === 'claude' ? 'Cho phép đến hết lượt này' : 'Luôn cho phép trong session';
    const actions = a.answerable
      ? `<div class="approval-actions"><button class="btn primary" data-approve="accept">Cho phép</button><button class="btn secondary small" data-approve="acceptForSession">${always}</button><button class="btn danger small" data-approve="decline">Từ chối</button></div>`
      : '<p class="muted">Yêu cầu này cần trả lời trên máy tính.</p>';
    return `<div class="approval" data-approval="${esc(a.id)}"><h3>${glyph(a.provider === 'claude' ? 'claude' : 'codex')}${esc(title)}</h3>${body}${actions}</div>`;
  }
  function renderApprovals() {
    const count = [...approvals.values()].filter(a => a.answerable).length, badge = $('#approval-badge');
    badge.textContent = count; badge.classList.toggle('hidden', !count);
    if (!view) { if (!$('#sessions-screen').classList.contains('hidden')) renderThreads(); return; }
    const stick = nearBottom(), box = $('#approvals');
    box.className = 'turn';
    box.innerHTML = [...approvals.values()].filter(a => a.threadId === view.id).map(approvalHtml).join('');
    box.querySelectorAll('[data-approve]').forEach(b => b.onclick = () => busy(b, async () => {
      const id = b.closest('[data-approval]').dataset.approval;
      await call('approve', { id, decision:b.dataset.approve }); approvals.delete(id); renderApprovals();
    }));
    setThreadStatus(view.thread.status);
    if (stick) toBottom();
  }

  // ---------- composer ----------
  const grow = el => { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, window.innerHeight * .4) + 'px'; };
  $('#prompt').oninput = e => grow(e.target);
  $('#new-prompt').oninput = e => grow(e.target);
  for (const [area, form] of [['#prompt', '#composer'], ['#new-prompt', '#new-form']])
    $(area).onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $(form).requestSubmit(); } };
  $('#composer').onsubmit = e => {
    e.preventDefault(); const text = $('#prompt').value; if (!text.trim() || !view) return;
    busy($('#send'), async () => {
      const fork = !!view.thread.openElsewhere;
      const r = await call('send', { threadId:view.id, text, fork });
      $('#prompt').value = ''; grow($('#prompt'));
      if (r.threadId && r.threadId !== view.id) { toast('Đã tạo nhánh mới.'); threads.unshift({ id:r.threadId, provider:'claude', title:text.slice(0, 160), cwd:view.thread.cwd, status:'active' }); openThread(r.threadId); return; }
      setThreadStatus('active');
    });
  };
  $('#stop-turn').onclick = e => busy(e.currentTarget, async () => { await call('interrupt', { threadId:view.id }); toast('Đã gửi yêu cầu dừng.'); });
  $('#thread-open').onclick = e => busy(e.currentTarget, async () => { if (!view) return; const r = await call('openOnComputer', { threadId:view.id }); toast(r.opened === 'terminal' ? 'Đã mở session bằng Claude Code trong cửa sổ terminal trên máy tính.' : 'Đã mở session trong VS Code trên máy tính.'); });

  // ---------- new session ----------
  async function loadFolders() {
    folderChoice = null;
    document.querySelectorAll('.seg').forEach(s => s.classList.toggle('active', s.dataset.provider === newProvider));
    $('#new-prompt').placeholder = newProvider === 'claude' ? 'Bạn muốn Claude làm gì?' : 'Bạn muốn Codex làm gì?';
    const list = $('#folder-list'); list.innerHTML = '<li class="empty">Đang tải…</li>';
    try {
      const { folders } = await call('folders', { provider:newProvider });
      folders.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (!folders.length) { list.innerHTML = '<li class="empty">Chưa có thư mục nào có session. Mở thư mục đó trên máy tính trước.</li>'; return; }
      list.innerHTML = folders.map((f, i) => `<li><button class="row" type="button" data-folder="${i}">${tile(newProvider)}<div class="row-body"><div class="row-top"><span class="row-title">${esc(f.name)}</span><span class="pill">${f.count}</span></div><small>${esc(f.path)}</small></div></button></li>`).join('');
      list.querySelectorAll('[data-folder]').forEach(b => b.onclick = () => { folderChoice = folders[+b.dataset.folder]; list.querySelectorAll('.row').forEach(r => r.classList.toggle('selected', r === b)); $('#new-prompt').focus(); });
    } catch (error) { if (!authFailure(error)) list.innerHTML = `<li class="empty">${esc(error.message)}</li>`; }
  }
  $('#new-session').onclick = () => { newProvider = provider === 'claude' ? 'claude' : 'codex'; $('#new-screen').classList.remove('hidden'); loadFolders(); };
  document.querySelectorAll('.seg').forEach(s => s.onclick = () => { if (newProvider !== s.dataset.provider) { newProvider = s.dataset.provider; loadFolders(); } });
  $('#new-back').onclick = () => $('#new-screen').classList.add('hidden');
  $('#new-form').onsubmit = e => {
    e.preventDefault(); const text = $('#new-prompt').value;
    if (!folderChoice) { toast('Chọn một thư mục trước.', true); return; }
    if (!text.trim()) { toast('Nhập yêu cầu trước khi bắt đầu.', true); return; }
    busy($('#new-send'), async () => {
      const r = await call('newThread', { provider:newProvider, cwd:folderChoice.path, text });
      $('#new-prompt').value = ''; $('#new-screen').classList.add('hidden');
      threads.unshift({ id:r.threadId, provider:newProvider, title:text.slice(0, 160), cwd:folderChoice.path, status:'active' });
      openThread(r.threadId);
    });
  };

  // ---------- quota ----------
  const planName = p => ({ free:'Free', plus:'Plus', pro:'Pro', max:'Max', team:'Team', business:'Business', enterprise:'Enterprise', edu:'Edu', go:'Go' }[p] || p);
  const windowName = w => { const m = w.windowDurationMins; if (!m) return w.kind === 'secondary' ? 'Dài hạn' : 'Ngắn hạn'; if (m === 10080) return 'Tuần'; if (m < 1440) return Math.round(m / 60) + ' giờ'; return Math.round(m / 1440) + ' ngày'; };
  const CLAUDE_WINDOWS = { five_hour:'5 giờ', seven_day:'Tuần', seven_day_opus:'Tuần · Opus', seven_day_sonnet:'Tuần · Sonnet' };
  const SOURCES = { statusline:'từ Claude Code', claude:'đọc trực tiếp', session:'từ lượt gần nhất' };
  function renderQuota() {
    if (!overview || tab !== 'quota') return;
    const g = overview.gateway, current = overview.accounts.find(a => a.id === g.profileId);
    $('#quota-summary').innerHTML = `<div class="stat"><small>Đang dùng</small><b>${esc(g.status === 'ready' ? current?.label || '—' : 'Chưa bật')}</b></div><div class="stat"><small>Tự chuyển khi hết quota</small><b>${overview.autoSwitch ? 'Bật' : 'Tắt'}</b></div>`;
    const list = $('#account-list');
    if (!overview.accounts.length) list.innerHTML = '<li class="empty">Chưa có tài khoản Codex nào.</li>';
    else list.innerHTML = overview.accounts.map(a => {
      const isCurrent = g.status === 'ready' && a.id === g.profileId;
      const status = a.status === 'reauth' ? '<span class="pill bad">Cần đăng nhập lại</span>' : a.status === 'error' ? '<span class="pill warn">Lỗi</span>' : a.refreshing ? '<span class="pill">Đang cập nhật</span>' : '';
      const windows = a.limits.flatMap(l => l.windows.map(w => ({ ...w, scope:a.limits.length > 1 ? l.name : null })));
      const rings = windows.length ? `<div class="rings">${windows.map(w => ring(100 - (Number(w.usedPercent) || 0), (w.scope ? w.scope + ' · ' : '') + windowName(w), until(w.resetsAt))).join('')}</div>` : '<p class="muted">Chưa có dữ liệu quota.</p>';
      return `<li class="card${isCurrent ? ' current' : ''}"><div class="account-head"><span class="account-name">${esc(a.label)}</span>${a.plan ? `<span class="pill">${esc(planName(a.plan))}</span>` : ''}${isCurrent ? '<span class="pill good">Đang dùng</span>' : ''}${status}</div>${rings}${a.lastError ? `<div class="account-error">${esc(a.lastError)}</div>` : ''}<div class="card-foot"><span>${a.quotaAt ? 'Cập nhật ' + esc(ago(Date.parse(a.quotaAt) / 1000)) : ''}</span><span class="spacer"></span>${isCurrent ? '' : `<button class="btn secondary small" data-use="${esc(a.id)}">Dùng</button>`}<button class="btn ghost small" data-hi="${esc(a.id)}"${overview.sayHi?.running ? ' disabled' : ''}>Say hi</button></div></li>`;
    }).join('');
    list.querySelectorAll('[data-use]').forEach(b => b.onclick = () => busy(b, async () => { overview = await call('useAccount', { id:b.dataset.use }); renderQuota(); toast('Đã chọn tài khoản. Lần gọi model tiếp theo sẽ dùng tài khoản này.'); }));
    list.querySelectorAll('[data-hi]').forEach(b => b.onclick = () => busy(b, async () => { await call('sayHi', { id:b.dataset.hi }); toast('Đang gửi Say hi…'); }));
    renderClaudeQuota();
  }
  function renderClaudeQuota() {
    const c = overview?.claude, box = $('#claude-quota');
    if (!c) { box.innerHTML = ''; return; }
    const u = c.usage;
    if (!u) {
      box.innerHTML = `<div class="hint">${c.refreshing ? 'Đang đọc quota từ Claude Code…' : 'Chưa có số liệu. Bấm Cập nhật, hoặc bật “Quota Claude” trong thẻ Điện thoại trên PADSwitcher để Claude Code tự ghi lại mỗi khi bạn dùng.'}</div>`;
      return;
    }
    box.innerHTML = `<div class="card"><div class="account-head"><span class="account-name">Claude Code</span>${u.plan ? `<span class="pill">${esc(planName(u.plan))}</span>` : ''}${c.active ? '<span class="pill live"><span class="dot active"></span>Đang chạy</span>' : ''}</div><div class="rings">${u.windows.map(w => ring(100 - w.usedPercent, CLAUDE_WINDOWS[w.kind] || w.kind, w.expired ? 'đã đặt lại' : until(w.resetsAt))).join('')}</div><div class="card-foot"><span>Cập nhật ${esc(ago(Math.floor(u.at / 1000)))} · ${esc(SOURCES[u.source] || '')}</span></div></div>`;
  }
  $('#refresh-quota').onclick = e => busy(e.currentTarget, async () => { overview = await call('refreshQuota'); renderQuota(); toast('Đã cập nhật quota Codex.'); });
  $('#refresh-claude').onclick = e => busy(e.currentTarget, async () => { overview = await call('claudeUsage'); renderQuota(); toast('Đã cập nhật quota Claude.'); });

  // ---------- kaggle ----------
  const NB_STATUS = { running:['live', 'Đang chạy'], queued:['', 'Chờ chạy'], complete:['good', 'Xong'], error:['bad', 'Lỗi'], cancelAcknowledged:['', 'Đã hủy'], cancelRequested:['', 'Đang hủy'] };
  const hours = v => (Math.round((Number(v) || 0) * 10) / 10).toLocaleString('vi-VN');
  // Kaggle reports UTC times without a zone suffix.
  const kaggleTime = s => { if (!s) return null; const t = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z'); return Number.isFinite(t) ? t / 1000 : null; };
  function renderKaggle() {
    if (!overview || tab !== 'kaggle') return;
    const list = $('#kaggle-list'), accounts = overview.kaggle?.accounts || [];
    if (!accounts.length) { list.innerHTML = '<li class="empty">Chưa có tài khoản Kaggle. Thêm trong PADSwitcher → Dịch vụ → Kaggle.</li>'; return; }
    list.innerHTML = accounts.map(a => {
      const meters = a.quota.map(q => {
        const remaining = q.remaining ?? (q.total - q.used), left = q.total ? Math.max(0, Math.min(100, remaining / q.total * 100)) : 0;
        const refresh = q.refreshAt ? new Date(kaggleTime(q.refreshAt) * 1000).toLocaleDateString('vi-VN', { weekday:'short', day:'numeric', month:'numeric' }) : '';
        return `<div class="meter"><div class="meter-label"><span>${esc(q.resource)}${refresh ? ' · làm mới ' + esc(refresh) : ''}</span><b>còn ${hours(remaining)} / ${hours(q.total)} giờ</b></div><div class="bar"><i class="${left <= 0 ? 'empty' : left < 20 ? 'low' : ''}" data-left="${left.toFixed(1)}"></i></div></div>`;
      }).join('');
      const notebooks = a.notebooks.slice().sort((x, y) => (y.watched - x.watched) || String(y.lastRunAt || '').localeCompare(String(x.lastRunAt || ''))).slice(0, 8);
      const nbs = notebooks.length ? `<ul class="nb-list">${notebooks.map(n => { const [cls, label] = NB_STATUS[n.status] || ['', n.status || '—']; return `<li class="nb"><div class="nb-body"><div class="nb-title">${n.watched ? '<span class="star">★</span> ' : ''}${esc(n.title || n.ref)}</div><div class="nb-meta">${esc([n.accelerator, ago(kaggleTime(n.lastRunAt))].filter(Boolean).join(' · '))}</div></div><span class="pill ${cls}">${cls === 'live' ? '<span class="dot active"></span>' : ''}${esc(label)}</span></li>`; }).join('')}</ul>` : '';
      return `<li class="card"><div class="account-head">${tile('kaggle')}<span class="account-name">${esc(a.label)}</span>${a.refreshing ? '<span class="pill">Đang cập nhật</span>' : a.status && a.status !== 'ready' ? `<span class="pill warn">${esc(a.status)}</span>` : ''}</div>${meters || '<p class="muted">Chưa có dữ liệu quota.</p>'}${a.lastError ? `<div class="account-error">${esc(a.lastError)}</div>` : ''}${nbs}</li>`;
    }).join('');
    // The page's CSP forbids inline style attributes; CSSOM writes are allowed.
    list.querySelectorAll('[data-left]').forEach(i => { i.style.width = i.dataset.left + '%'; });
  }
  $('#refresh-kaggle').onclick = e => busy(e.currentTarget, async () => { overview = await call('kaggleRefresh'); renderKaggle(); toast('Đã cập nhật Kaggle.'); });

  // ---------- start ----------
  async function start() {
    if (!secret) { showPair(); return; }
    setLink('waiting');
    document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.provider === provider));
    try { await call('hello'); showTab('sessions'); connectEvents(); loadThreads(); }
    catch (error) { if (!authFailure(error)) { showTab('sessions'); $('#thread-list').innerHTML = `<li class="empty">${esc(error.message)}</li>`; setLink('', 'Mất kết nối'); scheduleReconnect(); } }
  }
  start();
})();
