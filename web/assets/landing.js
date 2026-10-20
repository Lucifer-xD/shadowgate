/* ShadowGate — landing page motion (CSP-safe, no inline handlers) */
(() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // ── nav state ──────────────────────────────────────────────────────────
  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 24);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // ── live health probe (nav LED + hero readout) ─────────────────────────
  const fmtUp = (s) => {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  };
  async function probe() {
    const led = $('#status-led'), txt = $('#status-text');
    try {
      const t0 = performance.now();
      const r = await fetch('/healthz', { cache: 'no-store' });
      const j = await r.json();
      const ms = Math.round(performance.now() - t0);
      led.className = 'led';
      txt.textContent = `online · up ${fmtUp(j.uptime)}`;
      const ver = $('#ver'); if (ver && j.version) ver.textContent = `v${j.version}`;
      const ro = $('#ro-ttfb'); if (ro) ro.textContent = `${ms} ms`;
    } catch {
      led.className = 'led bad';
      txt.textContent = 'offline';
    }
  }
  probe();
  setInterval(probe, 30_000);

  // ── scroll reveal ──────────────────────────────────────────────────────
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { threshold: 0.12, rootMargin: '0px 0px -5% 0px' });
  $$('.reveal, .steps').forEach((el) => io.observe(el));

  // hero words — staggered mask reveal
  const title = $('#hero-title');
  if (title) {
    $$('.w', title).forEach((w, i) => { w.style.setProperty('--wd', `${0.08 + i * 0.07}s`); });
    requestAnimationFrame(() => setTimeout(() => title.classList.add('in'), 80));
  }

  // ── cursor spotlight on .spot cards ────────────────────────────────────
  if (!reduced) {
    document.addEventListener('pointermove', (e) => {
      const card = e.target.closest?.('.spot');
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    }, { passive: true });
  }

  // ── year ───────────────────────────────────────────────────────────────
  const y = $('#year'); if (y) y.textContent = new Date().getFullYear();

  // ── code tabs ──────────────────────────────────────────────────────────
  const tabs = $$('.tab'), ink = $('#tab-ink');
  const moveInk = (btn) => { if (!ink) return; ink.style.left = `${btn.offsetLeft}px`; ink.style.width = `${btn.offsetWidth}px`; };
  const activate = (name) => {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.code[data-pane]').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
    const btn = tabs.find((t) => t.dataset.tab === name); if (btn) moveInk(btn);
  };
  tabs.forEach((t) => t.addEventListener('click', () => activate(t.dataset.tab)));
  if (tabs.length) { activate('curl'); window.addEventListener('resize', () => moveInk(tabs.find((t) => t.classList.contains('active')))); }
  const copyBtn = $('#copy-btn');
  copyBtn?.addEventListener('click', async () => {
    const pane = $('.code.active');
    if (!pane) return;
    try {
      await navigator.clipboard.writeText(pane.innerText);
      copyBtn.textContent = 'copied'; copyBtn.classList.add('done');
      setTimeout(() => { copyBtn.textContent = 'copy'; copyBtn.classList.remove('done'); }, 1600);
    } catch { copyBtn.textContent = 'select & copy'; }
  });

  // ── pool rotation micro-demo ───────────────────────────────────────────
  const rows = $$('.pool-row');
  if (rows.length && !reduced) {
    let i = 0;
    setInterval(() => {
      rows.forEach((r) => r.classList.remove('active'));
      rows[i % 2].classList.add('active');
      i++;
    }, 1400);
  }

  // ── streaming micro-demo ───────────────────────────────────────────────
  const streamBox = $('#stream-demo');
  if (streamBox) {
    const sentences = [
      'Tokens arrive the moment ChatGPT emits them — no buffering, no waiting for the full reply.',
      'Every chunk is re-framed as an OpenAI chat.completion.chunk so existing clients just work.',
      'The stream ends with data: [DONE], exactly like the API you already use.',
    ];
    let s = 0;
    const run = () => {
      const words = sentences[s % sentences.length].split(' ');
      streamBox.innerHTML = '';
      let w = 0;
      const tick = () => {
        if (w < words.length) {
          const span = document.createElement('span');
          span.className = 'tok';
          span.textContent = (w ? ' ' : '') + words[w++];
          streamBox.appendChild(span);
          setTimeout(tick, reduced ? 0 : 70 + Math.random() * 90);
        } else {
          s++;
          setTimeout(run, 2600);
        }
      };
      tick();
    };
    run();
  }

  // ── hero terminal: typed request → streamed response ───────────────────
  const cmdEl = $('#term-cmd'), outEl = $('#term-out'), caret = $('#term-caret');
  if (cmdEl && outEl) {
    const cmd = `curl https://your-gate/v1/chat/completions \\\n  -H "Authorization: Bearer sg-••••" \\\n  -d '{"model":"gpt-5","stream":true,\n       "messages":[{"role":"user","content":"Describe ShadowGate in one line."}]}'`;
    const answer = 'A private, self-hosted gate that turns your ChatGPT sessions into an OpenAI-compatible API — streaming, pooled and encrypted at rest.';
    const type = (el, text, speed, done) => {
      let i = 0;
      const tick = () => {
        if (i <= text.length) { el.textContent = text.slice(0, i++); setTimeout(tick, speed + Math.random() * speed); }
        else done?.();
      };
      tick();
    };
    const streamOut = () => {
      outEl.innerHTML = '';
      const words = answer.split(' ');
      let w = 0;
      const t0 = performance.now();
      const roStream = $('#ro-stream'), roPool = $('#ro-pool');
      if (roPool) roPool.textContent = '1/1 healthy';
      const tick = () => {
        if (w < words.length) {
          const span = document.createElement('span');
          span.className = 'tok';
          span.textContent = (w ? ' ' : '') + words[w++];
          outEl.appendChild(span);
          if (roStream) roStream.textContent = `${w} tok · ${Math.round(performance.now() - t0)} ms`;
          setTimeout(tick, reduced ? 0 : 55 + Math.random() * 110);
        } else {
          const meta = document.createElement('span');
          meta.className = 'term-out-meta';
          meta.textContent = '\n\ndata: [DONE]  ·  ';
          const b = document.createElement('b');
          b.textContent = `${words.length} chunks · finish_reason=stop`;
          meta.appendChild(b);
          outEl.appendChild(meta);
          setTimeout(loop, 6000);
        }
      };
      tick();
    };
    const loop = () => {
      outEl.textContent = '';
      cmdEl.textContent = '';
      if (caret) caret.style.display = '';
      if (reduced) { cmdEl.textContent = cmd; streamOut(); return; }
      type(cmdEl, cmd, 14, () => { if (caret) caret.style.display = 'none'; setTimeout(streamOut, 450); });
    };
    const termIo = new IntersectionObserver((en) => { if (en[0].isIntersecting) { termIo.disconnect(); loop(); } }, { threshold: 0.3 });
    termIo.observe($('#term'));
  }
})();
