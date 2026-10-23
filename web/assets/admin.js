/* ShadowGate console — vanilla SPA, CSP-safe (no inline scripts/handlers) */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    csrf: '', // memory only — re-read from /api/admin/session on reload
    username: '',
    mustChangePw: false,
    totpEnabled: false,
    view: location.hash.replace('#', '') || 'chat',
    logs: { status: 'all', model: 'all', auto: false },
    timers: [],
  };

  // ── helpers ────────────────────────────────────────────────────────────
  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.body) headers['content-type'] = 'application/json';
    if (opts.method && opts.method !== 'GET') headers['x-csrf-token'] = state.csrf;
    const res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
    if (res.status === 401 && !path.endsWith('/login')) {
      showLogin();
      throw new Error('Session expired — sign in again.');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { body, status: res.status });
    return body;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (n) => new Intl.NumberFormat().format(n ?? 0);
  const ago = (iso) => {
    if (!iso) return '—';
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return `${Math.floor(s)}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };
  const hms = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dmy = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const clearTimers = () => { state.timers.forEach(clearInterval); state.timers = []; };
  const every = (ms, fn) => state.timers.push(setInterval(fn, ms));

  function toast(msg, type = '') {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    $('#toast-root').appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 350); }, 3800);
  }

  function modal(html) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    $('#modal-root').appendChild(back);
    const close = () => back.remove();
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) close(); });
    const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    setTimeout(() => $('input, textarea, button:not([data-close])', back)?.focus(), 50);
    back.close = close;
    return back;
  }

  function confirmModal(title, text, { danger = true, label = 'Confirm' } = {}) {
    return new Promise((resolve) => {
      const back = modal(`
        <h2>${title}</h2><p>${text}</p>
        <div class="row"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${label}</button></div>`);
      back.addEventListener('click', (e) => {
        if (e.target.closest('[data-yes]')) { back.close(); resolve(true); }
        else if (e.target === back || e.target.closest('[data-close]')) resolve(false);
      });
    });
  }

  // count-up for stat values
  function countUp(el, target, { suffix = '', decimals = 0, dur = 900 } = {}) {
    if (reduced) { el.textContent = `${target.toFixed(decimals)}${suffix}`; return; }
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = `${(target * eased).toFixed(decimals)}${suffix}`;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ── login ──────────────────────────────────────────────────────────────
  const loginEl = $('#login'), appEl = $('#app');

  function showLogin() {
    clearTimers();
    loginEl.classList.remove('hidden');
    appEl.classList.add('hidden');
    setTimeout(() => $('#in-user').focus(), 80);
  }

  function showApp() {
    loginEl.classList.add('hidden');
    appEl.classList.remove('hidden');
    $('#user-name').textContent = state.username;
    $('#user-avatar').textContent = state.username[0]?.toUpperCase() || 'A';
    $('#pw-banner').classList.toggle('hidden', !state.mustChangePw);
    switchView(VIEWS[state.view] ? state.view : 'dashboard');
  }

  async function bootstrap() {
    // decorate the login side panel with live health
    fetch('/healthz', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
      $('#ll-health').textContent = `online · up ${Math.floor(j.uptime / 3600)}h ${Math.floor((j.uptime % 3600) / 60)}m`;
      $('#ll-version').textContent = `v${j.version}`;
    }).catch(() => { $('#ll-health').textContent = 'unreachable'; });
    try {
      const s = await api('/api/admin/session');
      Object.assign(state, { csrf: s.csrf, username: s.username, mustChangePw: s.mustChangePw, totpEnabled: s.totpEnabled });
      showApp();
    } catch { showLogin(); }
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-btn'), err = $('#login-error');
    btn.disabled = true; err.textContent = '';
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ username: $('#in-user').value.trim(), password: $('#in-pass').value, totp: $('#in-totp').value.trim() || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.totpRequired) { $('#totp-row').classList.remove('hidden'); $('#in-totp').focus(); }
        throw new Error(body.error || 'Login failed');
      }
      Object.assign(state, { csrf: body.csrf, username: body.username, mustChangePw: body.mustChangePw, totpEnabled: body.totpEnabled });
      $('#in-pass').value = ''; $('#in-totp').value = '';
      showApp();
    } catch (ex) {
      err.textContent = ex.message;
      const card = $('#login-form');
      card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
    } finally { btn.disabled = false; }
  });

  $('#logout-btn').addEventListener('click', async () => {
    try { await api('/api/admin/logout', { method: 'POST' }); } catch { /* ignore */ }
    location.hash = '';
    location.reload();
  });

  // ── router ─────────────────────────────────────────────────────────────
  const VIEWS = {
    chat: { title: 'Chat', eyebrow: 'talk through the gate', render: renderChat },
    dashboard: { title: 'Dashboard', eyebrow: 'last 24 hours', render: renderDashboard },
    keys: { title: 'API keys', eyebrow: 'authenticate calls to /v1', render: renderKeys },
    tokens: { title: 'Sessions', eyebrow: 'the pool behind the gate', render: renderTokens },
    logs: { title: 'Requests', eyebrow: 'every gateway call, newest first', render: renderLogs },
    audit: { title: 'Audit trail', eyebrow: 'who did what, when', render: renderAudit },
    settings: { title: 'Settings', eyebrow: 'console security & preferences', render: renderSettings },
  };

  function switchView(name) {
    state.view = name;
    history.replaceState(null, '', `#${name}`);
    clearTimers();
    $$('.side-item[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    $$('.view').forEach((v) => v.classList.add('hidden'));
    $('.main').classList.toggle('chat-mode', name === 'chat');
    const el = $(`#view-${name}`);
    el.classList.remove('hidden');
    el.innerHTML = '<div class="skeleton"></div>';
    $('#view-title').textContent = VIEWS[name].title;
    $('#view-eyebrow').textContent = VIEWS[name].eyebrow;
    VIEWS[name].render(el).catch((ex) => {
      el.innerHTML = `<div class="card empty"><div class="glyph">!</div>${esc(ex.message)}</div>`;
    });
  }

  $('#side-nav').addEventListener('click', (e) => { const b = e.target.closest('.side-item[data-view]'); if (b) switchView(b.dataset.view); });
  $('#refresh-btn').addEventListener('click', () => { const b = $('#refresh-btn'); b.classList.remove('spin'); void b.offsetWidth; b.classList.add('spin'); switchView(state.view); });
  $('#pw-banner-btn').addEventListener('click', () => switchView('settings'));
  window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (VIEWS[v] && v !== state.view) switchView(v); });
  document.addEventListener('keydown', (e) => {
    if (appEl.classList.contains('hidden') || e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    const order = Object.keys(VIEWS);
    if (/^[1-7]$/.test(e.key)) switchView(order[+e.key - 1]);
    if (e.key === 'r') $('#refresh-btn').click();
  });

  // clock
  const clock = $('#clock');
  const tickClock = () => { clock.textContent = new Date().toLocaleTimeString([], { hour12: false }); };
  tickClock(); setInterval(tickClock, 1000);

  function setPoolPill(healthy, total) {
    const led = $('#pool-pill .led');
    $('#pool-pill-text').textContent = total ? `pool ${healthy}/${total} healthy` : 'pool empty';
    led.className = 'led ' + (total === 0 || healthy === 0 ? 'bad' : healthy < total ? 'warn' : '');
  }

  // ── usage meters (ChatGPT's 5-hour / weekly windows) ──
  const dur = (sec) => {
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
  };
  const meter = (name, w) => {
    if (!w) return '';
    const left = w.resets_at ? Math.max(0, (Date.parse(w.resets_at) - Date.now()) / 1000) : null;
    const tone = w.used_percent >= 90 ? 'bad' : w.used_percent >= 70 ? 'warn' : '';
    return `<div class="bar"><span class="name">${name}</span><div class="track"><div class="fill ${tone}" data-w="${w.used_percent}"></div></div><span class="num">${w.used_percent}%</span></div>
      <div class="reset ${w.used_percent >= 100 ? 'hit' : ''}">${w.remaining_percent}% left${left != null ? ` · resets in ${dur(left)}` : ''}</div>`;
  };
  const usageBlock = (u) => {
    if (!u || !u.fetched_at) return `<div class="usage"><div class="note">${u && u.error ? esc('usage: ' + u.error) : 'usage: not checked yet'}</div></div>`;
    const c = u.credits;
    const extra = [
      u.limit_reached ? '<b style="color:var(--bad)">limit reached</b>' : '',
      c ? (c.unlimited ? 'credits: unlimited' : c.hasCredits ? `credits: ${esc(String(c.balance ?? 'yes'))}` : 'no extra credits') : '',
      `checked ${ago(u.fetched_at)}`,
    ].filter(Boolean).join(' · ');
    return `<div class="usage">${meter('5-hour', u.five_hour)}${meter('weekly', u.weekly)}<div class="note">${extra}</div></div>`;
  };

  const statusBadge = (st) => ({
    healthy: '<span class="badge ok"><span class="bdot"></span>healthy</span>',
    cooling: '<span class="badge warn"><span class="bdot"></span>cooling</span>',
    expired: '<span class="badge bad"><span class="bdot"></span>expired</span>',
  }[st] || '<span class="badge"><span class="bdot"></span>verifying</span>');

  // ── dashboard ──────────────────────────────────────────────────────────
  function areaChart(hourly) {
    const W = 760, H = 230, PL = 36, PR = 16, PT = 16, PB = 28;
    const max = Math.max(1, ...hourly.map((h) => h.count));
    const x = (i) => PL + (i / Math.max(1, hourly.length - 1)) * (W - PL - PR);
    const y = (v) => PT + (1 - v / max) * (H - PT - PB);
    const pts = hourly.map((h, i) => ({ x: x(i), y: y(h.count), ye: y(h.errors), ...h }));
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const errs = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.ye.toFixed(1)}`).join(' ');
    const area = `${line} L${pts.at(-1).x.toFixed(1)},${H - PB} L${pts[0].x.toFixed(1)},${H - PB} Z`;
    const ticks = [0, 0.5, 1].map((f) => ({ y: y(max * f), v: Math.round(max * f) }));
    return `
      <div class="chart">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          <defs><linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff8a3d" stop-opacity=".38"/><stop offset="1" stop-color="#ff8a3d" stop-opacity="0"/></linearGradient></defs>
          <g class="grid">${ticks.map((t) => `<line x1="${PL}" x2="${W - PR}" y1="${t.y}" y2="${t.y}"/><text x="${PL - 8}" y="${t.y + 3}" text-anchor="end">${t.v}</text>`).join('')}</g>
          <path class="area" d="${area}"/>
          <path class="errs" d="${errs}"/>
          <path class="line" d="${line}"/>
          ${pts.map((p) => `<circle class="dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" data-h="${p.h}" data-c="${p.count}" data-e="${p.errors}"/>`).join('')}
          ${pts.filter((_, i) => i % 4 === 0 || i === pts.length - 1).map((p) => `<text x="${p.x.toFixed(1)}" y="${H - 8}" text-anchor="middle">${p.h}</text>`).join('')}
        </svg>
        <div class="tip"></div>
      </div>`;
  }

  const sparkline = (vals, cls = '') => {
    if (!vals.length) return '';
    const W = 96, H = 32, max = Math.max(1, ...vals);
    const pts = vals.map((v, i) => `${((i / Math.max(1, vals.length - 1)) * W).toFixed(1)},${(H - (v / max) * (H - 4) - 2).toFixed(1)}`).join(' ');
    return `<svg class="spark ${cls}" width="${W}" height="${H}"><polyline points="${pts}"/></svg>`;
  };

  async function renderDashboard(el, silent = false) {
    const s = await api('/api/admin/stats');
    setPoolPill(s.poolHealthy, s.poolTotal);
    $('#version-label').textContent = `v${s.version} · up ${Math.floor(s.uptimeSec / 3600)}h ${Math.floor((s.uptimeSec % 3600) / 60)}m`;
    const errRate = s.requests24h ? (s.errors24h / s.requests24h) * 100 : 0;
    el.innerHTML = `
      <div class="grid-4">
        <div class="card stat"><div class="lbl">requests · 24h</div><div class="val" data-count="${s.requests24h}">0</div><div class="trend">${nf(s.totalRequests)} logged in total</div>${sparkline(s.hourly.map((h) => h.count))}</div>
        <div class="card stat ${errRate > 10 ? 'bad' : ''}"><div class="lbl">error rate · 24h</div><div class="val" data-count="${errRate.toFixed(1)}" data-suffix="%" data-dec="1">0</div><div class="trend">${nf(s.errors24h)} failed requests</div>${sparkline(s.hourly.map((h) => h.errors), 'bad')}</div>
        <div class="card stat cool"><div class="lbl">avg latency</div><div class="val" data-count="${s.avgLatency}"><small>ms</small></div><div class="trend">upstream + gateway, 24h</div></div>
        <div class="card stat ${s.poolTotal && s.poolHealthy === s.poolTotal ? 'ok' : s.poolHealthy ? '' : 'bad'}"><div class="lbl">pool health</div><div class="val">${s.poolHealthy}<small>/ ${s.poolTotal}</small></div><div class="trend">${s.activeKeys}/${s.totalKeys} keys enabled</div></div>
      </div>
      <div class="grid-2">
        <div class="card"><h3>Requests per hour <span class="sub">ember = total · red = errors</span></h3>${areaChart(s.hourly)}</div>
        <div class="card">
          <h3>Model mix <span class="sub">24h</span></h3>
          ${s.models.length ? s.models.slice(0, 6).map((m) => `<div class="bar"><span class="name">${esc(m.model)}</span><div class="track"><div class="fill" data-w="${((m.count / s.models[0].count) * 100).toFixed(1)}"></div></div><span class="num">${nf(m.count)}</span></div>`).join('') : '<div class="empty"><div class="glyph">∅</div>No requests in the last 24 hours</div>'}
          ${s.topKeys.length ? `<h3 style="margin-top:1.4rem">Top keys <span class="sub">24h</span></h3>${s.topKeys.map((k) => `<div class="bar"><span class="name">${esc(k.name)}</span><div class="track"><div class="fill cool" data-w="${((k.count / s.topKeys[0].count) * 100).toFixed(1)}"></div></div><span class="num">${nf(k.count)}</span></div>`).join('')}` : ''}
          <h3 style="margin-top:1.4rem">Pool <span class="sub">${s.poolTotal} session${s.poolTotal === 1 ? '' : 's'}</span></h3>
          <div class="pool-list">${s.pool.length ? s.pool.map((t) => `<div class="pool-item"><span class="led ${t.status === 'healthy' ? '' : t.status === 'expired' ? 'bad' : t.status === 'cooling' ? 'warn' : 'off'}"></span><span>${esc(t.label)} <span class="mono">${esc(t.email || '')}</span></span><span class="mono">${esc(t.plan || t.status)}</span></div><div class="pool-usage">${usageBlock(t.usage)}</div>`).join('') : '<div class="empty" style="padding:1rem"><span>No sessions yet — add one under Sessions.</span></div>'}</div>
        </div>
      </div>
      <div class="card tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Key</th><th>Model</th><th>Status</th><th>Latency</th><th>Stream</th></tr></thead>
        <tbody>${s.recent.length ? s.recent.map((r) => `<tr><td class="dim">${hms(r.ts)}</td><td>${esc(r.keyName ?? r.keyId.slice(0, 8))}</td><td class="mono">${esc(r.model)}</td><td><span class="badge ${r.status < 400 ? 'ok' : 'bad'}">${r.status}</span></td><td class="mono">${nf(r.latencyMs)} ms</td><td class="dim">${r.stream ? 'sse' : 'json'}</td></tr>`).join('') : '<tr><td colspan="6"><div class="empty"><div class="glyph">…</div>Nothing yet. Fire a request at <code>/v1/chat/completions</code>.</div></td></tr>'}</tbody></table></div>`;

    // animate numbers + bars
    $$('.val[data-count]', el).forEach((v) => {
      const target = parseFloat(v.dataset.count), dec = +(v.dataset.dec || 0), suffix = v.dataset.suffix || '';
      const small = v.querySelector('small');
      v.textContent = '';
      const span = document.createElement('span'); v.appendChild(span);
      countUp(span, target, { decimals: dec, suffix });
      if (small) v.appendChild(small);
    });
    requestAnimationFrame(() => $$('.fill', el).forEach((f) => { f.style.width = `${f.dataset.w}%`; }));
    const chart = $('.chart', el);
    if (chart) {
      const tip = $('.tip', chart), svg = $('svg', chart);
      chart.addEventListener('mousemove', (e) => {
        const dot = e.target.closest('.dot');
        if (!dot) { tip.style.display = 'none'; return; }
        const r = svg.getBoundingClientRect();
        tip.style.display = 'block';
        tip.style.left = `${(parseFloat(dot.getAttribute('cx')) / 760) * r.width}px`;
        tip.style.top = `${(parseFloat(dot.getAttribute('cy')) / 230) * r.height}px`;
        tip.innerHTML = `<b>${dot.dataset.h}</b> · ${nf(dot.dataset.c)} req · ${nf(dot.dataset.e)} err`;
      });
      chart.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    }
    if (!silent) every(15000, () => { if (state.view === 'dashboard') renderDashboard(el, true).catch(() => {}); });
  }

  // ── keys ───────────────────────────────────────────────────────────────
  async function renderKeys(el) {
    const { keys } = await api('/api/admin/keys');
    el.innerHTML = `
      <div class="toolbar"><span class="count">${keys.length} key${keys.length === 1 ? '' : 's'}</span><div class="spacer"></div><button class="btn btn-primary" id="new-key">Create key <span class="arrow">→</span></button></div>
      <div class="card tbl-wrap">${keys.length ? `<table class="tbl">
        <thead><tr><th>Name</th><th>Key</th><th>Enabled</th><th>Limits</th><th>Requests</th><th>Last used</th><th>Created</th><th></th></tr></thead>
        <tbody>${keys.map((k) => `<tr data-id="${k.id}">
          <td><b>${esc(k.name)}</b></td>
          <td class="mono dim">${esc(k.prefix)}••••••••</td>
          <td><label class="switch"><input type="checkbox" data-toggle ${k.enabled ? 'checked' : ''}><span class="track"></span></label></td>
          <td class="mono dim">${k.rpm}/min · ${nf(k.rpd)}/day</td>
          <td class="mono">${nf(k.totalRequests)}</td>
          <td class="dim">${ago(k.lastUsed)}</td>
          <td class="dim">${dmy(k.createdAt)}</td>
          <td><div class="actions"><button class="icon-btn" data-edit title="Edit limits"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25ZM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z" fill="currentColor"/></svg></button><button class="icon-btn danger" data-del title="Delete"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Z" fill="currentColor"/></svg></button></div></td>
        </tr>`).join('')}</tbody></table>` : '<div class="empty"><div class="glyph">sg-</div>No keys yet. Create one to start calling the API.</div>'}</div>`;

    $('#new-key', el).addEventListener('click', () => {
      const back = modal(`
        <h2>Create <em>API key</em></h2>
        <label class="field"><span>name</span><input id="mk-name" placeholder="my-app" maxlength="60"></label>
        <div class="grid-2b">
          <label class="field"><span>requests / minute</span><input id="mk-rpm" type="number" value="120" min="1" max="10000"></label>
          <label class="field"><span>requests / day</span><input id="mk-rpd" type="number" value="20000" min="1" max="1000000"></label>
        </div>
        <div class="row"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="mk-go">Create</button></div>`);
      const go = async () => {
        try {
          const res = await api('/api/admin/keys', { method: 'POST', body: JSON.stringify({ name: $('#mk-name', back).value, rpm: +$('#mk-rpm', back).value, rpd: +$('#mk-rpd', back).value }) });
          back.close();
          const reveal = modal(`
            <h2>Copy it <em>now.</em></h2>
            <p>This is the only time the full key is shown. ShadowGate keeps a SHA-256 hash, nothing else.</p>
            <div class="key-reveal" id="key-val">${esc(res.key)}</div>
            <div class="row"><button class="btn btn-ghost" data-copy>Copy</button><button class="btn btn-primary" data-close>Done</button></div>`);
          reveal.addEventListener('click', async (e) => {
            const b = e.target.closest('[data-copy]');
            if (b) { try { await navigator.clipboard.writeText(res.key); b.textContent = 'Copied'; } catch { b.textContent = 'Select & copy'; } }
            if (e.target === reveal || e.target.closest('[data-close]')) renderKeys(el);
          });
          toast('API key created', 'ok');
        } catch (ex) { toast(ex.message, 'bad'); }
      };
      $('#mk-go', back).addEventListener('click', go);
      back.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    });

    el.addEventListener('change', async (e) => {
      const t = e.target.closest('[data-toggle]');
      if (!t) return;
      const id = t.closest('tr').dataset.id;
      try { await api(`/api/admin/keys/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: t.checked }) }); toast(t.checked ? 'Key enabled' : 'Key disabled', 'ok'); }
      catch (ex) { toast(ex.message, 'bad'); t.checked = !t.checked; }
    });
    el.addEventListener('click', async (e) => {
      const row = e.target.closest('tr[data-id]');
      if (!row) return;
      const id = row.dataset.id;
      const key = keys.find((k) => k.id === id);
      if (e.target.closest('[data-del]')) {
        if (await confirmModal('Delete this key?', `Requests signed with <b>${esc(key.name)}</b> will get 401 immediately. This cannot be undone.`, { label: 'Delete' })) {
          try { await api(`/api/admin/keys/${id}`, { method: 'DELETE' }); toast('Key deleted', 'ok'); renderKeys(el); } catch (ex) { toast(ex.message, 'bad'); }
        }
      }
      if (e.target.closest('[data-edit]')) {
        const back = modal(`
          <h2>Edit <em>${esc(key.name)}</em></h2>
          <label class="field"><span>name</span><input id="ek-name" value="${esc(key.name)}" maxlength="60"></label>
          <div class="grid-2b">
            <label class="field"><span>requests / minute</span><input id="ek-rpm" type="number" value="${key.rpm}" min="1" max="10000"></label>
            <label class="field"><span>requests / day</span><input id="ek-rpd" type="number" value="${key.rpd}" min="1" max="100000"></label>
          </div>
          <div class="row"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="ek-go">Save</button></div>`);
        $('#ek-go', back).addEventListener('click', async () => {
          try {
            await api(`/api/admin/keys/${id}`, { method: 'PATCH', body: JSON.stringify({ name: $('#ek-name', back).value, rpm: +$('#ek-rpm', back).value, rpd: +$('#ek-rpd', back).value }) });
            back.close(); toast('Key updated', 'ok'); renderKeys(el);
          } catch (ex) { toast(ex.message, 'bad'); }
        });
      }
    });
  }

  // ── sessions ───────────────────────────────────────────────────────────
  async function renderTokens(el) {
    const { tokens } = await api('/api/admin/tokens');
    setPoolPill(tokens.filter((t) => t.status === 'healthy').length, tokens.length);
    el.innerHTML = `
      <div class="toolbar"><span class="count">${tokens.length} session${tokens.length === 1 ? '' : 's'} in the pool</span><div class="spacer"></div><button class="btn btn-primary" id="add-token">Add session <span class="arrow">→</span></button></div>
      <div class="sessions">${tokens.length ? tokens.map((t) => `
        <div class="card session ${t.status}" data-id="${t.id}">
          <div class="head">${statusBadge(t.status)}<span class="t-label">${esc(t.label)}</span><button class="icon-btn" data-rename title="Rename"><svg viewBox="0 0 24 24" width="13" height="13"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25ZM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z" fill="currentColor"/></svg></button></div>
          <div class="meta">
            <span>account</span><b>${esc(t.email || 'unknown')}</b>
            <span>plan</span><b>${esc(t.plan || '—')}</b>
            <span>device</span><b class="mono">${esc(t.deviceId)}</b>
            <span>verified</span><b>${ago(t.lastVerified || t.lastRefresh)}</b>
            <span>last used</span><b>${ago(t.lastUsed)}</b>
            ${t.coolUntil ? `<span>cooldown</span><b>${Math.max(0, Math.ceil((t.coolUntil - Date.now()) / 60000))} min left</b>` : ''}
            ${t.models?.length ? `<span>models</span><b title="${esc(t.models.map((m) => m.slug).join('\n'))}">${t.models.length} · default ${esc(t.defaultModel || '—')}</b>` : ''}
          </div>
          <div data-usage="${t.id}">${usageBlock(t.usage)}</div>
          ${t.models?.length ? `<div class="lanes">${t.models.filter((m) => m.slug !== 'research').map((m) => `<span class="lane ${m.workMode ? 'work' : esc(m.reasoning)}" title="${esc(m.title)}${m.workMode ? ' · work mode' : ''}${m.efforts.length ? ' · effort: ' + m.efforts.join('/') : ''}">${esc(m.workMode ? m.title : m.slug)}</span>`).join('')}</div>` : ''}
          ${t.lastError ? `<div class="err-line">${esc(t.lastError)}</div>` : ''}
          <div class="actions"><button class="btn btn-sm" data-verify>Verify now</button><div class="spacer"></div><button class="btn btn-sm btn-danger" data-del>Remove</button></div>
        </div>`).join('') : '<div class="card empty" style="grid-column:1/-1"><div class="glyph">⌁</div>The pool is empty. Add a ChatGPT session to bring the gate online.</div>'}</div>`;

    const paintFills = () => requestAnimationFrame(() => $$('.fill', el).forEach((f) => { f.style.width = `${f.dataset.w}%`; }));
    paintFills();
    if (tokens.length) {
      api('/api/admin/usage').then((r) => {
        for (const a of r.accounts) { const box = el.querySelector(`[data-usage="${a.id}"]`); if (box) box.innerHTML = usageBlock(a); }
        paintFills();
      }).catch(() => { /* keep the cached meters */ });
    }

    $('#add-token', el).addEventListener('click', () => {
      const back = modal(`
        <h2>Add a <em>session</em></h2>
        <p>Paste the <code>__Secure-next-auth.session-token</code> cookie value from chatgpt.com, or a full session export JSON. Exports are preferred: the device id and user agent inside them keep anti-bot challenges away. Everything is encrypted with AES-256-GCM before it touches disk.</p>
        <label class="field"><span>label</span><input id="at-label" placeholder="main-account" maxlength="60"></label>
        <p class="dim" style="font-size:.82rem;margin:0 0 .4rem">Not sure how to get it? <a href="/docs#sessions" target="_blank" rel="noopener">Two-minute guide with a ready script</a>.</p>
        <label class="field"><span>session token or export json</span><textarea id="at-token" placeholder="eyJhbGciOiJkaXIiOi…  or  { &quot;sessionToken&quot;: … }" spellcheck="false"></textarea></label>
        <div class="row"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="at-go">Add &amp; verify</button></div>`);
      $('#at-go', back).addEventListener('click', async () => {
        const btn = $('#at-go', back); btn.disabled = true;
        try {
          // send the raw paste — the server parses export JSON itself (keeps deviceId + UA)
          const res = await api('/api/admin/tokens', { method: 'POST', body: JSON.stringify({ label: $('#at-label', back).value, sessionToken: $('#at-token', back).value.trim() }) });
          back.close();
          toast(res.ok ? 'Session added — verifying in the background' : 'That session is already in the pool', res.ok ? 'ok' : '');
          renderTokens(el);
          if (res.ok) setTimeout(() => { if (state.view === 'tokens') renderTokens(el).catch(() => {}); }, 6000);
        } catch (ex) { toast(ex.message, 'bad'); btn.disabled = false; }
      });
    });

    el.addEventListener('click', async (e) => {
      const card = e.target.closest('.session');
      if (!card) return;
      const id = card.dataset.id;
      const t = tokens.find((x) => x.id === id);
      if (e.target.closest('[data-verify]')) {
        const btn = e.target.closest('[data-verify]');
        btn.disabled = true; btn.textContent = 'Verifying…';
        try {
          const r = await api(`/api/admin/tokens/${id}/verify`, { method: 'POST' });
          toast(r.ok ? `Verified — ${r.detail}` : `Failed — ${r.detail}`, r.ok ? 'ok' : 'bad');
          renderTokens(el);
        } catch (ex) { toast(ex.message, 'bad'); btn.disabled = false; btn.textContent = 'Verify now'; }
      }
      if (e.target.closest('[data-rename]')) {
        const back = modal(`<h2>Rename <em>session</em></h2><label class="field"><span>label</span><input id="rn-label" value="${esc(t.label)}" maxlength="60"></label><div class="row"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="rn-go">Save</button></div>`);
        $('#rn-go', back).addEventListener('click', async () => {
          try { await api(`/api/admin/tokens/${id}`, { method: 'PATCH', body: JSON.stringify({ label: $('#rn-label', back).value }) }); back.close(); toast('Renamed', 'ok'); renderTokens(el); } catch (ex) { toast(ex.message, 'bad'); }
        });
      }
      if (e.target.closest('[data-del]')) {
        if (await confirmModal('Remove this session?', `<b>${esc(t.label)}</b> is deleted from the encrypted store. In-flight requests on it may fail.`, { label: 'Remove' })) {
          try { await api(`/api/admin/tokens/${id}`, { method: 'DELETE' }); toast('Session removed', 'ok'); renderTokens(el); } catch (ex) { toast(ex.message, 'bad'); }
        }
      }
    });
    every(20000, () => { if (state.view === 'tokens') renderTokens(el).catch(() => {}); });
  }

  // ── logs ───────────────────────────────────────────────────────────────
  async function renderLogs(el) {
    const f = state.logs;
    const load = () => api(`/api/admin/logs?status=${f.status}&model=${encodeURIComponent(f.model)}&limit=100`);
    const { items, total } = await load();
    el.innerHTML = `
      <div class="toolbar">
        <div class="chips">${['all', 'ok', 'error'].map((s) => `<button class="chip ${f.status === s ? 'active' : ''}" data-st="${s}">${s === 'ok' ? '2xx' : s === 'error' ? 'errors' : 'all'}</button>`).join('')}</div>
        <select class="sel" id="log-model"><option value="all">all models</option></select>
        <span class="count" id="log-count">${nf(total)} matching</span>
        <div class="spacer"></div>
        <label class="toggle"><input type="checkbox" id="log-auto" ${f.auto ? 'checked' : ''}> auto-refresh</label>
      </div>
      <div class="card tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Key</th><th>Model</th><th>Status</th><th>Latency</th><th>Chars in → out</th><th>Mode</th><th>Notes / error</th></tr></thead><tbody id="log-rows"></tbody></table></div>`;

    const paint = (rows, known = new Set()) => {
      const tbody = $('#log-rows', el);
      tbody.innerHTML = rows.length ? rows.map((r) => `
        <tr data-k="${r.ts}|${r.latencyMs}" class="${known.size && !known.has(`${r.ts}|${r.latencyMs}`) ? 'new' : ''}" ${r.error ? 'data-err="1"' : ''}>
          <td class="dim" style="white-space:nowrap">${hms(r.ts)}</td>
          <td>${esc(r.keyName)}</td>
          <td class="mono">${esc(r.model)}</td>
          <td><span class="badge ${r.status < 400 ? 'ok' : r.status === 499 ? 'warn' : 'bad'}">${r.status}</span></td>
          <td class="mono">${nf(r.latencyMs)} ms</td>
          <td class="mono dim">${nf(r.charsIn)} → ${nf(r.charsOut)}</td>
          <td class="dim">${r.stream ? 'sse' : 'json'}</td>
          <td class="mono" style="font-size:.72rem;color:${r.error ? 'var(--bad)' : 'var(--dim)'}"><span class="ellip" title="${esc(r.error || r.notes || '')}">${esc(r.error || r.notes || '')}</span></td>
        </tr>`).join('') : '<tr><td colspan="8"><div class="empty"><div class="glyph">…</div>No requests match this filter.</div></td></tr>';
    };
    paint(items);
    const sel = $('#log-model', el);
    for (const m of [...new Set(items.map((i) => i.model))]) sel.add(new Option(m, m));
    sel.value = f.model;

    const refresh = async () => {
      const known = new Set($$('#log-rows tr', el).map((r) => r.dataset.k));
      const { items: rows, total: tot } = await load();
      paint(rows, known);
      const c = $('#log-count', el); if (c) c.textContent = `${nf(tot)} matching`;
    };
    $$('.chip[data-st]', el).forEach((c) => c.addEventListener('click', () => { f.status = c.dataset.st; renderLogs(el); }));
    sel.addEventListener('change', () => { f.model = sel.value; renderLogs(el); });
    const arm = () => every(6000, () => { if (state.view === 'logs') refresh().catch(() => {}); });
    $('#log-auto', el).addEventListener('change', (e) => { f.auto = e.target.checked; clearTimers(); if (f.auto) arm(); });
    if (f.auto) arm();
    // click a row with an error to expand it
    el.addEventListener('click', (e) => {
      const row = e.target.closest('tr[data-err]');
      if (!row) return;
      const next = row.nextElementSibling;
      if (next?.classList.contains('detail')) { next.remove(); return; }
      const d = document.createElement('tr'); d.className = 'detail';
      d.innerHTML = `<td colspan="8"><div class="err-line">${esc(row.querySelector('.ellip').title)}</div></td>`;
      row.after(d);
    });
  }

  // ── audit ──────────────────────────────────────────────────────────────
  async function renderAudit(el) {
    const { items } = await api('/api/admin/audit');
    const cls = (a) => /fail|delete|revoke|disable/.test(a) ? 'bad' : /login_ok|create|add|enable|verify/.test(a) ? 'ok' : /change|update|setup/.test(a) ? 'ember' : 'warn';
    el.innerHTML = `
      <div class="toolbar"><span class="count">${items.length} most recent entries</span></div>
      <div class="card audit">${items.length ? items.map((a) => `<div class="audit-row"><span class="when">${new Date(a.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span><span class="what ${cls(a.action)}">${esc(a.action.replace(/_/g, ' '))}</span><span class="detail" title="${esc(a.detail)}">${esc(a.detail || '—')} <span class="mono dim">· ip ${esc(a.ipHash.slice(0, 8))}</span></span></div>`).join('') : '<div class="empty"><div class="glyph">…</div>No audit entries yet.</div>'}</div>`;
  }

  // ── settings ───────────────────────────────────────────────────────────
  async function renderSettings(el) {
    const s = await api('/api/admin/settings');
    state.totpEnabled = s.totpEnabled;
    el.innerHTML = `
      <div class="grid-2b">
        <div class="card form">
          <h3>Password</h3>
          <label class="field"><span>current password</span><input type="password" id="pw-cur" autocomplete="current-password"></label>
          <label class="field"><span>new password</span><input type="password" id="pw-new" autocomplete="new-password"><span class="hint">At least 10 characters. Changing it signs out every other console session.</span></label>
          <label class="field"><span>repeat new password</span><input type="password" id="pw-new2" autocomplete="new-password"></label>
          <div class="row" style="display:flex;justify-content:flex-end"><button class="btn btn-primary" id="pw-save">Change password</button></div>
        </div>
        <div class="card form">
          <h3>Two-factor authentication ${s.totpEnabled ? '<span class="badge ok"><span class="bdot"></span>on</span>' : '<span class="badge"><span class="bdot"></span>off</span>'}</h3>
          <p class="dim" style="font-size:.86rem">Time-based one-time codes (Google Authenticator, Authy, 1Password…). Protects the console even if the password leaks.</p>
          ${s.totpEnabled
            ? `<label class="field"><span>confirm password to disable</span><input type="password" id="totp-off-pw" autocomplete="current-password"></label><div style="display:flex;justify-content:flex-end"><button class="btn btn-danger" id="totp-off">Disable 2FA</button></div>`
            : `<div style="display:flex;justify-content:flex-end"><button class="btn btn-primary" id="totp-on">Set up 2FA</button></div><div id="totp-setup"></div>`}
        </div>
      </div>
      <div class="grid-2b">
        <div class="card form">
          <h3>Console</h3>
          <label class="field"><span>brand name</span><input id="set-brand" value="${esc(s.brandName)}" maxlength="40"></label>
          <label class="toggle"><input type="checkbox" id="set-record" ${s.recordApi ? 'checked' : ''}> record /v1 API conversations in Chat (read-only transcripts, stored on this server)</label>
          <label class="field"><span>conversation continuation</span>
            <select id="set-cont">
              <option value="temp" ${s.continuation === 'temp' ? 'selected' : ''}>plain and bare GPT-6 models — temporary chats, nothing saved in the account (default)</option>
              <option value="all" ${s.continuation === 'all' ? 'selected' : ''}>also -wm work-mode models — their chats are SAVED in the ChatGPT account while active and run through the Codex work experience, which spends the workspace's work credits</option>
              <option value="off" ${s.continuation === 'off' ? 'selected' : ''}>off — resend the whole history every turn</option>
            </select></label>
          <p class="dim" style="font-size:.78rem">A request that is the previous conversation plus new messages sends only the new messages upstream. Edited or compacted histories fall back to a full resend automatically.</p>
          <div style="display:flex;justify-content:flex-end"><button class="btn" id="set-save">Save</button></div>
          <h3 style="margin-top:.6rem">Admin sessions</h3>
          <p class="dim" style="font-size:.86rem">Sessions last 8 hours. Revoking signs out every console, including this one.</p>
          <div style="display:flex;justify-content:flex-end"><button class="btn" id="revoke-btn">Revoke all sessions</button></div>
        </div>
        <div class="card">
          <h3>Deployment</h3>
          <div class="kv">
            <span>version</span><b>v${esc(s.version)}</b>
            <span>admin user</span><b>${esc(s.username)}</b>
            <span>public url</span><b>${esc(s.publicBaseUrl)}</b>
            <span>trust proxy</span><b>${s.trustProxy ? `${s.trustProxy} hop${s.trustProxy > 1 ? 's' : ''}` : 'off (direct)'}</b>
            <span>ip allowlist</span><b>${s.ipAllowlist.length ? esc(s.ipAllowlist.join(', ')) : 'not set'}</b>
            <span>default limits</span><b>${s.defaultRpm}/min · ${nf(s.defaultRpd)}/day</b>
          </div>
          <p class="dim" style="font-size:.78rem;margin-top:1rem">These come from <code>.env</code> on the server and need a restart to change.</p>
        </div>
      </div>`;

    $('#set-save', el).addEventListener('click', async () => {
      try { await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ brandName: $('#set-brand', el).value, recordApi: $('#set-record', el).checked, continuation: $('#set-cont', el).value }) }); toast('Saved', 'ok'); } catch (ex) { toast(ex.message, 'bad'); }
    });
    $('#pw-save', el).addEventListener('click', async () => {
      const cur = $('#pw-cur', el).value, nw = $('#pw-new', el).value, nw2 = $('#pw-new2', el).value;
      if (nw !== nw2) { toast('New passwords do not match', 'bad'); return; }
      try {
        await api('/api/admin/password', { method: 'POST', body: JSON.stringify({ current: cur, next: nw }) });
        state.mustChangePw = false; $('#pw-banner').classList.add('hidden');
        toast('Password changed — other sessions revoked', 'ok'); renderSettings(el);
      } catch (ex) { toast(ex.message, 'bad'); }
    });
    $('#totp-on', el)?.addEventListener('click', async () => {
      try {
        const setup = await api('/api/admin/totp/setup', { method: 'POST' });
        $('#totp-setup', el).innerHTML = `
          <div class="form" style="margin-top:1rem">
            <label class="field"><span>secret (manual entry)</span><div class="mono-box">${esc(setup.secret)}</div></label>
            <label class="field"><span>otpauth uri</span><div class="mono-box" style="font-size:.7rem">${esc(setup.otpauth)}</div></label>
            <label class="field"><span>enter the 6-digit code</span><input id="totp-code" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code"></label>
            <div style="display:flex;justify-content:flex-end"><button class="btn btn-primary" id="totp-confirm">Enable</button></div>
          </div>`;
        $('#totp-code', el).focus();
        $('#totp-confirm', el).addEventListener('click', async () => {
          try { await api('/api/admin/totp/enable', { method: 'POST', body: JSON.stringify({ code: $('#totp-code', el).value }) }); toast('2FA enabled', 'ok'); renderSettings(el); } catch (ex) { toast(ex.message, 'bad'); }
        });
      } catch (ex) { toast(ex.message, 'bad'); }
    });
    $('#totp-off', el)?.addEventListener('click', async () => {
      try { await api('/api/admin/totp/disable', { method: 'POST', body: JSON.stringify({ password: $('#totp-off-pw', el).value }) }); toast('2FA disabled', 'ok'); renderSettings(el); } catch (ex) { toast(ex.message, 'bad'); }
    });
    $('#revoke-btn', el).addEventListener('click', async () => {
      if (await confirmModal('Revoke all sessions?', 'Every console session, including this one, is signed out immediately.', { danger: false, label: 'Revoke' })) {
        try { await api('/api/admin/sessions/revoke', { method: 'POST' }); } catch { /* 401 expected afterwards */ }
        location.hash = ''; location.reload();
      }
    });
  }

  // ── chat ───────────────────────────────────────────────────────────────
  // markdown-lite: escape first, then a handful of safe transforms
  function md(src) {
    const blocks = [];
    let text = esc(src ?? '');
    text = text.replace(/```([\w+-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      blocks.push(`<pre>${lang ? `<span class="lang">${lang}</span>` : ''}<code>${code.replace(/\n$/, '')}</code></pre>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    const inline = (s) => s
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const lines = text.split('\n');
    const out = [];
    let para = [], list = null;
    const flushP = () => { if (para.length) { out.push(`<p>${inline(para.join('<br>'))}</p>`); para = []; } };
    const flushL = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      let m;
      if (/^\u0000\d+\u0000$/.test(line.trim())) { flushP(); flushL(); out.push(line.trim()); continue; }
      if (!line.trim()) { flushP(); flushL(); continue; }
      if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { flushP(); flushL(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
      if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flushP(); flushL(); out.push('<hr>'); continue; }
      if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { flushP(); if (!list || list.tag !== 'ul') { flushL(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); continue; }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushP(); if (!list || list.tag !== 'ol') { flushL(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); continue; }
      if ((m = line.match(/^>\s?(.*)$/))) { flushP(); flushL(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
      flushL(); para.push(line);
    }
    flushP(); flushL();
    return out.join('\n').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
  }

  const chat = { list: [], current: null, models: [], defaultModel: 'auto', controller: null, q: '' };

  async function renderChat(el) {
    const [{ items }, cat] = await Promise.all([api('/api/admin/chats'), api('/api/admin/models').catch(() => ({ models: [], defaultModel: 'auto' }))]);
    chat.list = items; chat.models = cat.models || []; chat.defaultModel = cat.defaultModel || 'auto';
    el.innerHTML = `
      <div class="chat" id="chat">
        <aside class="chat-side">
          <div class="chat-side-top">
            <button class="btn btn-primary btn-sm btn-block" id="chat-new">New chat</button>
            <input class="chat-search" id="chat-search" placeholder="Search chats…" value="${esc(chat.q)}">
          </div>
          <div class="chat-list" id="chat-list"></div>
        </aside>
        <section class="chat-main">
          <header class="chat-head">
            <button class="icon-btn burger" id="chat-burger" title="Chats"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 6h16v2H4zM4 11h16v2H4zM4 16h16v2H4z" fill="currentColor"/></svg></button>
            <input class="chat-title" id="chat-title" placeholder="Untitled chat" maxlength="80">
            <select class="sel" id="chat-model" title="Model"></select>
            <select class="sel" id="chat-effort" title="Thinking effort"><option value="">effort: auto</option><option value="standard">effort: standard</option><option value="extended">effort: extended</option></select>
            <button class="icon-btn danger" id="chat-del" title="Delete chat"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Z" fill="currentColor"/></svg></button>
          </header>
          <div class="chat-msgs" id="chat-msgs"></div>
          <form class="chat-composer" id="chat-form">
            <textarea id="chat-input" rows="1" placeholder="Message the gate… (Enter to send, Shift+Enter for a new line)"></textarea>
            <button class="chat-send" id="chat-send" type="submit" title="Send"><svg viewBox="0 0 24 24"><path d="M3 11.5 20 4l-7.5 17-1.9-7.1L3 11.5Z"/></svg></button>
          </form>
          <div class="chat-foot" id="chat-foot">model: — · effort: auto</div>
        </section>
      </div>`;

    // model picker
    const sel = $('#chat-model', el);
    sel.add(new Option(`auto · account default (${chat.defaultModel})`, 'auto'));
    const direct = chat.models.filter((m) => m.direct);
    if (direct.length) {
      const g = document.createElement('optgroup'); g.label = 'GPT-6 family';
      for (const m of direct) g.appendChild(new Option(`${m.title} · ${m.slug}`, m.slug));
      sel.appendChild(g);
    }
    const wm = chat.models.filter((m) => m.workMode);
    if (wm.length) {
      const g = document.createElement('optgroup'); g.label = 'GPT-6 family · work mode';
      for (const m of wm) g.appendChild(new Option(`${m.title} · ${m.slug}`, m.slug));
      sel.appendChild(g);
    }
    const lanes = [['reasoning', 'Thinking'], ['pro', 'Pro'], ['instant', 'Instant'], ['none', 'Instant'], ['auto', 'Router']];
    for (const [lane, label] of lanes) {
      const ms = chat.models.filter((m) => m.reasoning === lane && !m.workMode && !m.direct);
      if (!ms.length) continue;
      const g = document.createElement('optgroup'); g.label = label;
      for (const m of ms) g.appendChild(new Option(`${m.slug} · ${m.title}`, m.slug));
      sel.appendChild(g);
    }
    const rest = chat.models.filter((m) => !m.workMode && !m.direct && !lanes.some(([l]) => l === m.reasoning));
    if (rest.length) { const g = document.createElement('optgroup'); g.label = 'Other'; for (const m of rest) g.appendChild(new Option(`${m.slug} · ${m.title}`, m.slug)); sel.appendChild(g); }

    const paintList = () => {
      const groups = [['Today', 0], ['Yesterday', 1], ['Last 7 days', 7], ['Older', Infinity]];
      const day = 86400_000, now = Date.now();
      const bucket = (iso) => { const d = (now - Date.parse(iso)) / day; return d < 1 ? 0 : d < 2 ? 1 : d < 7 ? 7 : Infinity; };
      let html = '';
      for (const [label, b] of groups) {
        const items = chat.list.filter((c) => bucket(c.updatedAt) === b);
        if (!items.length) continue;
        html += `<div class="chat-group">${label}</div>` + items.map((c) => `
          <button class="chat-item ${chat.current?.id === c.id ? 'active' : ''}" data-id="${c.id}">
            <span class="t">${esc(c.title)}</span>
            <span class="m">${c.source === 'api' ? `<span class="src">api · ${esc(c.keyName || '')}</span>` : ''}<span>${esc(c.model)}</span><span>· ${c.count}</span><span>· ${ago(c.updatedAt)}</span></span>
            <span class="del" data-del title="Delete">×</span>
          </button>`).join('');
      }
      $('#chat-list', el).innerHTML = html || '<div class="empty" style="padding:2rem 1rem"><div class="glyph">…</div>No chats yet.<br>Start one above.</div>';
    };

    const foot = () => {
      const m = sel.value === 'auto' ? chat.defaultModel : sel.value;
      const info = chat.models.find((x) => x.slug === m);
      const eff = $('#chat-effort', el);
      const supports = info?.efforts?.length ? info.efforts : [];
      eff.disabled = !supports.length;
      [...eff.options].forEach((o) => { o.disabled = o.value && !supports.includes(o.value); });
      if (eff.value && !supports.includes(eff.value)) eff.value = '';
      $('#chat-foot', el).textContent = `model: ${m}${info?.title ? ` (${info.title})` : ''} · effort: ${eff.value || (supports.length ? 'default' : 'n/a')} · history is sent in full each turn`;
    };

    const paintMessages = () => {
      const box = $('#chat-msgs', el);
      const c = chat.current;
      if (!c) {
        box.innerHTML = `<div class="chat-empty"><div class="display">Talk through <em>the gate.</em></div><div>Pick a model and a thinking effort above, or just type. Conversations are stored on this server, nowhere else.</div><div class="hints">${['Explain the sentinel handshake in two lines', 'Write a haiku about rate limits', 'Draft a terse README intro'].map((h) => `<button class="chip" data-hint>${h}</button>`).join('')}</div></div>`;
        return;
      }
      box.innerHTML = c.messages.map((m) => renderMsg(m)).join('') || `<div class="chat-empty"><div class="display">New <em>chat.</em></div><div>Say something.</div></div>`;
      box.scrollTop = box.scrollHeight;
    };
    const renderMsg = (m, streaming = false) => `
      <div class="msg ${m.role} ${streaming ? 'streaming' : ''}" data-mid="${m.id}">
        <div class="mark">${m.role === 'user' ? esc((state.username[0] || 'u').toUpperCase()) : '<img src="/assets/logo.svg?v=1.19.1" alt="">'}</div>
        <div class="body">
          ${m.role === 'assistant' && m.reasoning ? `<details class="think"><summary>Thought process</summary><div>${esc(m.reasoning)}</div></details>` : ''}
          <div class="bubble ${m.error && !m.content ? 'err' : ''} ${m.role === 'assistant' ? 'md' : ''}">${m.role === 'assistant' ? (m.content ? md(m.content) : esc(m.error || '')) : esc(m.content)}</div>
          <div class="meta">${m.role === 'assistant' ? `<span class="model">${esc(m.model || '')}</span>${m.effort ? `<span>${esc(m.effort)}</span>` : ''}${m.latencyMs ? `<span>${(m.latencyMs / 1000).toFixed(1)}s</span>` : ''}` : ''}<span>${hms(m.ts)}</span>${m.role === 'user' ? '<button data-retry title="Delete this and everything after, then resend">retry</button>' : ''}<button data-copy>copy</button></div>
        </div>
      </div>`;

    const open = async (id) => {
      const { conversation } = await api(`/api/admin/chats/${id}`);
      chat.current = conversation;
      $('#chat-title', el).value = conversation.title;
      sel.value = chat.models.some((m) => m.slug === conversation.model) ? conversation.model : 'auto';
      $('#chat-effort', el).value = conversation.effort || '';
      foot(); paintList(); paintMessages();
      $('#chat', el).classList.remove('list-open');
      $('#chat-input', el).focus();
    };
    const fresh = () => {
      chat.current = null;
      $('#chat-title', el).value = '';
      paintList(); paintMessages(); foot();
      $('#chat', el).classList.remove('list-open');
      $('#chat-input', el).focus();
    };
    const reload = async () => { const { items } = await api(`/api/admin/chats?q=${encodeURIComponent(chat.q)}`); chat.list = items; paintList(); };

    const send = async (text) => {
      if (chat.controller) return; // already streaming
      text = text.trim(); if (!text) return;
      if (!chat.current) {
        const { conversation } = await api('/api/admin/chats', { method: 'POST', body: JSON.stringify({ model: sel.value, effort: $('#chat-effort', el).value }) });
        chat.current = conversation; chat.list.unshift({ ...conversation, count: 0, last: '' });
        $('#chat-title', el).value = conversation.title;
      }
      const c = chat.current;
      const input = $('#chat-input', el); input.value = ''; input.style.height = '';
      const box = $('#chat-msgs', el);
      if (!c.messages.length) box.innerHTML = '';
      const tmpUser = { id: 'tmp-u', role: 'user', content: text, ts: new Date().toISOString() };
      box.insertAdjacentHTML('beforeend', renderMsg(tmpUser));
      const tmpBot = { id: 'tmp-a', role: 'assistant', content: '', ts: new Date().toISOString(), model: '' };
      box.insertAdjacentHTML('beforeend', renderMsg(tmpBot, true));
      const botEl = $('[data-mid="tmp-a"]', box), bubble = $('.bubble', botEl), metaModel = $('.meta .model', botEl);
      bubble.innerHTML = '<span class="thinking"><i></i><i></i><i></i> connecting</span>';
      box.scrollTop = box.scrollHeight;
      const btn = $('#chat-send', el); btn.classList.add('stop'); btn.title = 'Stop'; btn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
      chat.controller = new AbortController();
      const t0 = performance.now(); let acc = ''; let think = ''; let timer = null;
      const thinkEl = () => { let d = $('.think', botEl); if (!d) { d = document.createElement('details'); d.className = 'think live'; d.open = true; d.innerHTML = '<summary>Thinking…</summary><div></div>'; bubble.before(d); } return d; };
      try {
        const res = await fetch(`/api/admin/chats/${c.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': state.csrf }, credentials: 'same-origin', body: JSON.stringify({ content: text, model: sel.value, effort: $('#chat-effort', el).value }), signal: chat.controller.signal });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
        timer = setInterval(() => { if (!acc) bubble.innerHTML = `<span class="thinking"><i></i><i></i><i></i> thinking · ${((performance.now() - t0) / 1000).toFixed(1)}s</span>`; }, 200);
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, nl); buf = buf.slice(nl + 2);
            if (!frame.startsWith('data: ')) continue;
            let ev; try { ev = JSON.parse(frame.slice(6)); } catch { continue; }
            if (ev.type === 'user') { $('[data-mid="tmp-u"]', box).dataset.mid = ev.message.id; }
            if (ev.type === 'model') { metaModel.textContent = ev.model + (ev.effort ? ` · ${ev.effort}` : ''); }
            if (ev.type === 'reasoning') { think += ev.text; const d = thinkEl(); $('div', d).textContent = think; if (!acc) bubble.innerHTML = `<span class="thinking"><i></i><i></i><i></i> thinking · ${((performance.now() - t0) / 1000).toFixed(1)}s</span>`; box.scrollTop = box.scrollHeight; }
            if (ev.type === 'delta') { acc += ev.text; bubble.innerHTML = md(acc); const d = $('.think', botEl); if (d) { d.classList.remove('live'); d.open = false; d.querySelector('summary').textContent = 'Thought process'; } box.scrollTop = box.scrollHeight; }
            if (ev.type === 'error') { bubble.classList.add('err'); bubble.textContent = ev.message; }
            if (ev.type === 'done') { botEl.outerHTML = renderMsg(ev.message); c.messages.push(tmpUser, ev.message); c.title = ev.conversation.title; $('#chat-title', el).value = c.title; }
          }
        }
      } catch (ex) {
        if (ex.name === 'AbortError') { bubble.innerHTML = md(acc || '') + '<p class="dim"><em>stopped</em></p>'; }
        else { bubble.classList.add('err'); bubble.textContent = ex.message; }
      } finally {
        clearInterval(timer); chat.controller = null; botEl.classList.remove('streaming');
        btn.classList.remove('stop'); btn.title = 'Send'; btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 11.5 20 4l-7.5 17-1.9-7.1L3 11.5Z"/></svg>';
        await reload().catch(() => {});
        if (chat.current) { try { const { conversation } = await api(`/api/admin/chats/${chat.current.id}`); chat.current = conversation; paintMessages(); } catch { /* keep */ } }
      }
    };

    // events
    $('#chat-new', el).addEventListener('click', fresh);
    $('#chat-burger', el).addEventListener('click', () => $('#chat', el).classList.toggle('list-open'));
    $('#chat-search', el).addEventListener('input', (e) => { chat.q = e.target.value; clearTimeout(chat.qt); chat.qt = setTimeout(reload, 250); });
    $('#chat-list', el).addEventListener('click', async (e) => {
      const item = e.target.closest('.chat-item'); if (!item) return;
      if (e.target.closest('[data-del]')) {
        if (await confirmModal('Delete this chat?', 'The conversation is removed from this server.', { label: 'Delete' })) {
          await api(`/api/admin/chats/${item.dataset.id}`, { method: 'DELETE' });
          if (chat.current?.id === item.dataset.id) chat.current = null;
          await reload(); paintMessages();
        }
        return;
      }
      open(item.dataset.id).catch((ex) => toast(ex.message, 'bad'));
    });
    $('#chat-del', el).addEventListener('click', async () => {
      if (!chat.current) return;
      if (await confirmModal('Delete this chat?', 'The conversation is removed from this server.', { label: 'Delete' })) {
        await api(`/api/admin/chats/${chat.current.id}`, { method: 'DELETE' }); chat.current = null; await reload(); paintMessages();
      }
    });
    $('#chat-title', el).addEventListener('change', async (e) => {
      if (!chat.current) return;
      await api(`/api/admin/chats/${chat.current.id}`, { method: 'PATCH', body: JSON.stringify({ title: e.target.value }) }); chat.current.title = e.target.value; reload();
    });
    sel.addEventListener('change', async () => { foot(); if (chat.current) await api(`/api/admin/chats/${chat.current.id}`, { method: 'PATCH', body: JSON.stringify({ model: sel.value }) }); });
    $('#chat-effort', el).addEventListener('change', async (e) => { foot(); if (chat.current) await api(`/api/admin/chats/${chat.current.id}`, { method: 'PATCH', body: JSON.stringify({ effort: e.target.value }) }); });
    const input = $('#chat-input', el);
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(220, input.scrollHeight)}px`; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chat-form', el).requestSubmit(); } });
    $('#chat-form', el).addEventListener('submit', (e) => {
      e.preventDefault();
      if (chat.controller) { chat.controller.abort(); return; }
      send(input.value).catch((ex) => toast(ex.message, 'bad'));
    });
    $('#chat-msgs', el).addEventListener('click', async (e) => {
      const hint = e.target.closest('[data-hint]'); if (hint) { input.value = hint.textContent; input.focus(); return; }
      const msgEl = e.target.closest('.msg'); if (!msgEl || !chat.current) return;
      const m = chat.current.messages.find((x) => x.id === msgEl.dataset.mid); if (!m) return;
      if (e.target.closest('[data-copy]')) { try { await navigator.clipboard.writeText(m.content); toast('Copied', 'ok'); } catch { toast('Clipboard blocked', 'bad'); } }
      if (e.target.closest('[data-retry]')) {
        const { conversation } = await api(`/api/admin/chats/${chat.current.id}/messages/${m.id}`, { method: 'DELETE' });
        chat.current = conversation; paintMessages(); send(m.content).catch((ex) => toast(ex.message, 'bad'));
      }
    });

    paintList(); paintMessages(); foot();
    if (chat.current) open(chat.current.id).catch(() => fresh());
  }

  bootstrap();
})();
