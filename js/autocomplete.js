// Yazarken adres önerisi kutusu. Google anahtarı varsa Google Places, yoksa Photon (OSM).
window.RB = window.RB || {};

(function (RB) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * @param {HTMLInputElement} input
   * @param {{getRegion: () => object|null, onPick: (geo, text) => void, onEnter?: (text) => void}} o
   */
  function attach(input, o) {
    const box = document.createElement('div');
    box.className = 'ac-box';
    box.hidden = true;
    input.parentElement.style.position = 'relative';
    input.insertAdjacentElement('afterend', box);
    input.setAttribute('autocomplete', 'off');

    let items = [], active = -1, timer = null, seq = 0;

    const close = () => { box.hidden = true; active = -1; };
    function render() {
      if (!items.length) return close();
      box.innerHTML = items.map((s, i) =>
        `<div class="ac-item${i === active ? ' on' : ''}" data-i="${i}"><b>${esc(s.main)}</b><small>${esc(s.sub)}</small></div>`).join('');
      box.hidden = false;
    }
    async function pick(i) {
      const s = items[i];
      if (!s) return;
      close();
      input.value = s.text;
      try {
        const geo = s.geo || await RB.google.details(s.id);
        o.onPick(geo, s.text);
      } catch (e) {
        console.error(e);
        o.onEnter && o.onEnter(s.text);
      }
    }

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 3) { items = []; return close(); }
      timer = setTimeout(async () => {
        const my = ++seq;
        try {
          const region = await o.getRegion();
          const res = RB.google.enabled() ? await RB.google.suggest(q, region) : await RB.geo.suggestFree(q, region);
          if (my !== seq) return;
          items = res.slice(0, 6); active = -1; render();
        } catch (e) { console.warn(e); }
      }, 280);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && items.length) { active = (active + 1) % items.length; render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp' && items.length) { active = (active - 1 + items.length) % items.length; render(); e.preventDefault(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (!box.hidden && active >= 0) pick(active);
        else { close(); o.onEnter && input.value.trim() && o.onEnter(input.value.trim()); }
      } else if (e.key === 'Escape') close();
    });
    box.addEventListener('mousedown', (e) => {
      const it = e.target.closest('.ac-item');
      if (it) { e.preventDefault(); pick(+it.dataset.i); }
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    return { close };
  }

  RB.autocomplete = { attach };
})(window.RB);
