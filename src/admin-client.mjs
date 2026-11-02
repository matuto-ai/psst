// Static, CSP-hashed progressive enhancement. Never interpolate labels or credentials here.
export const adminClient = String.raw`(() => {
  'use strict';
  const root = document.documentElement;
  root.classList.add('has-script');
  const media = matchMedia('(prefers-color-scheme: dark)');
  let theme = 'system';
  try { theme = localStorage.getItem('psst-admin-theme') || 'system'; } catch {}
  if (!['light', 'dark', 'system'].includes(theme)) theme = 'system';
  function applyTheme() { root.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme; }
  applyTheme();
  media.addEventListener('change', applyTheme);
  document.addEventListener('DOMContentLoaded', () => {
    const themeSelect = document.querySelector('[data-theme-choice]');
    if (themeSelect) {
      themeSelect.value = theme;
      themeSelect.addEventListener('change', () => {
        theme = themeSelect.value;
        try { localStorage.setItem('psst-admin-theme', theme); } catch {}
        applyTheme();
      });
    }
    function remember(url) {
      try { sessionStorage.setItem('psst-admin-list:' + url.pathname, url.pathname + url.search); } catch {}
      restoreLinks();
    }
    function restoreLinks() {
      document.querySelectorAll('[data-list-link]').forEach(link => {
        try {
          const saved = sessionStorage.getItem('psst-admin-list:' + link.dataset.listLink);
          if (saved) { const url = new URL(saved, location.origin); if (url.origin === location.origin && url.pathname === link.dataset.listLink) link.href = url.pathname + url.search; }
        } catch {}
      });
    }
    restoreLinks();
    const form = document.querySelector('[data-live-filters]');
    if (!form) return;
    const status = document.querySelector('[data-filter-status]');
    const cancel = document.querySelector('[data-filter-cancel]');
    const retry = document.querySelector('[data-filter-retry]');
    const region = () => document.querySelector('[data-results]');
    const defaults = Object.fromEntries([...form.elements].filter(el => el.name).map(el => [el.name, el.dataset.default || '']));
    let applied = new URL(location.href), desired = applied, timer, controller, sequence = 0;
    let composing = false;
    form.dataset.enhanced = 'true';
    remember(applied);
    function restoreAppliedURL() { if (location.href !== applied.href) history.replaceState(null, '', applied.pathname + applied.search); }
    function say(message) { status.textContent = message; }
    function syncForm(url) {
      for (const el of form.elements) if (el.name) {
        el.value = url.searchParams.get(el.name) ?? defaults[el.name];
        if (el.value && el.closest('.advanced-filters')) el.closest('.advanced-filters').open = true;
      }
    }
    function stop() {
      clearTimeout(timer); sequence++; controller?.abort(); controller = null;
      region()?.removeAttribute('aria-busy'); cancel.hidden = true; retry.hidden = true;
    }
    function valid() {
      for (const el of form.elements) {
        if (!el.name || !el.value) continue;
        if (el.dataset.kind === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(el.value)) return 'Enter a complete session UUID to update results.';
        if (el.name === 'installation_id' && !/^[-a-zA-Z0-9_.]{1,128}$/.test(el.value)) return 'Use a complete installation identifier to update results.';
        if (el.dataset.kind === 'name' && /[\u0000-\u001f\u007f]/.test(el.value)) return 'Remove control characters to update results.';
        if (el.dataset.kind === 'utc' && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{3})?)?Z$/.test(el.value) || !Number.isFinite(Date.parse(el.value)) || new Date(el.value).toISOString() !== (el.value.length === 17 ? el.value.replace('Z', ':00.000Z') : el.value.length === 20 ? el.value.replace('Z', '.000Z') : el.value))) return 'Enter a complete UTC date and time to update results.';
        if (el.value.length > Number(el.maxLength > 0 ? el.maxLength : 2048)) return 'Shorten this filter to update results.';
      }
      const after = form.elements.namedItem('accepted_after')?.value, before = form.elements.namedItem('accepted_before')?.value;
      if (after && before && Date.parse(after) > Date.parse(before)) return 'Accepted after must be no later than accepted before.';
      return '';
    }
    function formURL() {
      const url = new URL(form.action);
      for (const [key, value] of new FormData(form)) if (value) url.searchParams.set(key, value);
      return url;
    }
    async function navigate(url, push = true, restore = false) {
      stop(); desired = url;
      if (restore) syncForm(url);
      const problem = valid();
      if (problem) { say(problem + ' Previous results are unchanged.'); return; }
      const current = sequence, active = new AbortController(); controller = active;
      region().setAttribute('aria-busy', 'true'); cancel.hidden = false; say('Updating results…');
      try {
        const response = await fetch(url, { credentials: 'same-origin', signal: active.signal, headers: { Accept: 'text/html' } });
        const body = await response.text();
        if (current !== sequence) return;
        if (!response.ok) throw Error(response.status === 400 || response.status === 409 ? 'Filters or pagination are no longer valid. Refresh the first page.' : 'The broker could not load these results.');
        const doc = new DOMParser().parseFromString(body, 'text/html'), next = doc.querySelector('[data-results]');
        if (!next || !doc.querySelector('[data-live-filters]')) throw Error('Your admin session may have expired. Reload this page to log in.');
        const previous = region(), focused = previous.contains(document.activeElement), sort = document.activeElement?.dataset?.sort;
        previous.replaceWith(document.importNode(next, true));
        if (focused) { const target = sort ? region().querySelector('[data-sort="' + sort + '"]') : region().querySelector('.card-head'); if (target) { if (!sort) target.tabIndex = -1; target.focus({ preventScroll: true }); } }
        applied = url;
        if (push && location.href !== url.href) history.pushState(null, '', url.pathname + url.search);
        remember(url);
        const count = next.querySelectorAll('tbody tr').length;
        say(count + (count === 1 ? ' result.' : ' results.') + ' Updated.');
      } catch (error) {
        if (current !== sequence || error.name === 'AbortError') return;
        restoreAppliedURL(); say(error.message + ' Previous results are unchanged.'); retry.hidden = false;
      } finally {
        if (current === sequence) { controller = null; region()?.removeAttribute('aria-busy'); cancel.hidden = true; }
      }
    }
    function changed(immediate) {
      stop();
      const problem = valid();
      if (problem) { say(problem + ' Previous results are unchanged.'); return; }
      desired = formURL();
      if (immediate) navigate(desired);
      else { say('Waiting for typing to finish…'); cancel.hidden = false; timer = setTimeout(() => navigate(desired), 300); }
    }
    form.addEventListener('compositionstart', () => { composing = true; stop(); });
    form.addEventListener('compositionend', () => { composing = false; changed(false); });
    form.addEventListener('input', event => { if (!composing && event.target.tagName !== 'SELECT') changed(false); });
    form.addEventListener('change', event => { if (event.target.tagName === 'SELECT') changed(true); });
    form.addEventListener('submit', event => { event.preventDefault(); changed(true); });
    cancel.addEventListener('click', () => { stop(); syncForm(applied); restoreAppliedURL(); say('Update cancelled. Previous results retained.'); });
    retry.addEventListener('click', () => navigate(desired));
    document.addEventListener('click', event => {
      const link = event.target.closest('a[data-list-read]');
      if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin || url.pathname !== form.getAttribute('action')) return;
      event.preventDefault();
      if (link.hasAttribute('data-list-refresh')) navigate(formURL());
      else if (link.dataset.sort) {
        const fresh = formURL(); fresh.searchParams.set('sort', link.dataset.sort); fresh.searchParams.set('direction', link.dataset.direction);
        navigate(fresh, true, true);
      } else navigate(url, true, true);
    });
    addEventListener('popstate', () => navigate(new URL(location.href), false, true));
    addEventListener('pagehide', stop);
  });
})();`;
