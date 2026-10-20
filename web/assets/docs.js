/* ShadowGate — docs page behaviour (CSP-safe) */
(() => {
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const nav = document.getElementById('nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 24);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // base url for this deployment
  const base = document.getElementById('base-url');
  if (base) base.textContent = `${location.origin}/v1`;

  // copy buttons
  $$('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pre = btn.closest('.codeblock')?.querySelector('pre');
      if (!pre) return;
      try {
        await navigator.clipboard.writeText(pre.innerText);
        btn.textContent = 'copied'; btn.classList.add('done');
        setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('done'); }, 1500);
      } catch { btn.textContent = 'select & copy'; }
    });
  });

  // active section highlighting
  const links = $$('#toc a');
  const targets = links.map((a) => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${e.target.id}`));
    }
  }, { rootMargin: '-20% 0px -70% 0px', threshold: 0 });
  targets.forEach((t) => io.observe(t));
})();
