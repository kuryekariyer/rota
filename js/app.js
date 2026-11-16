// Uygulama: adres listesi, ayarlar, harita ve rota akışı
(function (RB) {
  const P = RB.parse, G = RB.geo, GG = RB.google;
  const $ = (id) => document.getElementById(id);
  const el = {
    quick: $('quickInput'), quickBtn: $('quickBtn'), pick: $('pickBtn'), file: $('fileInput'), drop: $('dropZone'),
    ocr: $('ocrStatus'), bulkToggle: $('bulkToggle'), bulkBox: $('bulkBox'), addr: $('addrInput'), bulkCount: $('bulkCount'),
    bulkAdd: $('bulkAdd'), listSummary: $('listSummary'), clear: $('clearBtn'), list: $('addrList'),
    start: $('startInput'), gps: $('gpsBtn'), end: $('endInput'), region: $('regionInput'), depart: $('departInput'),
    service: $('serviceInput'), profile: $('profileInput'), goalHint: $('goalHint'),
    gKey: $('gKeyInput'), gSave: $('gKeySave'), gState: $('gState'), gUsage: $('gUsage'),
    route: $('routeBtn'), progress: $('progress'), result: $('resultCard'), summary: $('summary'),
    warnings: $('warnings'), nav: $('navLinks'), stops: $('stopList'), recalc: $('recalcBtn'), copy: $('copyBtn'),
    banner: $('pickBanner'),
    nextCard: $('nextCard'), nextLabel: $('nextLabel'), nextAddr: $('nextAddr'), nextMeta: $('nextMeta'),
    nextExtra: $('nextExtra'), nextGo: $('nextGo'), nextDone: $('nextDone'), nextFail: $('nextFail'),
    nextEdit: $('nextEdit'), undo: $('undoBtn'), finish: $('finishCard'), failFill: $('failFill'),
    tabAddr: $('tabAddr'), tabRoute: $('tabRoute'), tabCount: $('tabAddrCount'), empty: $('emptyState'),
    settingsSum: $('settingsSummary'), navHint: $('navHint'), doneFill: $('doneFill'), doneText: $('doneText'),
    warnCount: $('warnCount'),
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const radio = (name) => document.querySelector(`input[name=${name}]:checked`).value;
  const setRadio = (name, v) => { const r = document.querySelector(`input[name=${name}][value=${v}]`); if (r) r.checked = true; };

  // Öncelik: km başına kaç dakikalık gecikmeye razıyız (maliyet = trafikli süre + ağırlık × km)
  const GOALS = {
    km: { w: 6, hint: 'Toplam km\'yi en aza indirir; sadece trafik ciddi gecikme yaratıyorsa (km başına 6+ dk) biraz daha uzun yolu seçer.' },
    balanced: { w: 2, hint: 'Km ve trafikli süre arasında denge kurar.' },
    fast: { w: 0, hint: 'Trafikli toplam süreyi en aza indirir, km\'ye bakmaz.' },
  };

  // ---------- Kalıcı durum ----------
  const SETTINGS = 'rb:settings:v2', ITEMS = 'rb:items:v1';
  let startGeo = null, endGeo = null; // öneriden seçilen / GPS
  let items = []; // {id, raw, geo, status}
  const uid = () => Math.random().toString(36).slice(2, 9);

  function saveSettings() {
    G.store.set(SETTINGS, {
      start: el.start.value, startGeo, end: el.end.value, endGeo, region: el.region.value, depart: el.depart.value,
      service: el.service.value, profile: el.profile.value, endMode: radio('endMode'), goal: radio('goal'),
      navApp: radio('navApp'),
    });
    updateSettingsSummary();
  }

  // Ayarlar kapalıyken tek satırlık özet
  const NAV_NAMES = { google: 'Google Maps', yandex: 'Yandex' };
  function updateSettingsSummary() {
    const start = el.start.value.trim() || 'Bulunduğun yer';
    const end = { open: 'son durakta biter', return: 'başa döner', fixed: 'bitiş: ' + (el.end.value.trim() || '?') }[radio('endMode')];
    const goal = { km: 'en az km', balanced: 'dengeli', fast: 'en hızlı' }[radio('goal')];
    el.settingsSum.textContent = `${start} · ${end} · ${goal} · ${NAV_NAMES[radio('navApp')]}`;
    el.navHint.textContent = radio('navApp') === 'google'
      ? 'Önerilen. Kapı numarasını en isabetli bulan seçenek.'
      : 'Yandex bazı adreslerde kapı numarası yerine en yakın binayı ya da sadece caddeyi bulabilir.';
  }
  function loadSettings() {
    const s = G.store.get(SETTINGS) || {};
    el.start.value = s.start || ''; startGeo = s.startGeo || null;
    el.end.value = s.end || ''; endGeo = s.endGeo || null;
    el.region.value = s.region || ''; el.depart.value = s.depart || '';
    el.service.value = s.service ?? 5; el.profile.value = s.profile || 'driving';
    setRadio('endMode', s.endMode || 'open'); setRadio('goal', s.goal || 'km'); setRadio('navApp', s.navApp || 'google');
    items = (G.store.get(ITEMS) || []).map((x) => ({ ...x, status: x.geo ? x.status : 'pending' }));
  }
  const saveItems = () => G.store.set(ITEMS, items.map(({ id, raw, geo, status, picked, note, amount }) => ({ id, raw, geo, status, picked, note, amount })));

  // ---------- Günlük teslim işaretleri ----------
  // Günlük durak durumu: 'done' (teslim edildi) / 'failed' (edilemedi); geri alınabilir
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
  const statusKey = () => 'rb:status:' + today();
  const getStatus = () => G.store.get(statusKey()) || {};
  const undoStack = [];
  function setStatus(raw, st, remember = true) {
    const s = getStatus(); const k = P.cacheKey(raw);
    if (remember) undoStack.push({ raw, prev: s[k] || null });
    if (st) s[k] = st; else delete s[k];
    G.store.set(statusKey(), s);
  }

  // Durak notu ve kapıda tahsil edilecek tutar (adres listesindeki kayda bağlı)
  const itemOf = (raw) => items.find((i) => P.cacheKey(i.raw) === P.cacheKey(raw));
  const parseMoney = (v) => { const n = parseFloat(String(v || '').replace(/\./g, '').replace(',', '.')); return isFinite(n) && n > 0 ? n : 0; };
  const fmtMoney = (n) => n.toLocaleString('tr-TR', { maximumFractionDigits: 2 }) + ' ₺';

  // ---------- Harita ----------
  const map = L.map('map').setView([38.42, 27.14], 11); // İzmir
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  new ResizeObserver(() => map.invalidateSize()).observe(document.getElementById('map'));
  const routeLayer = L.layerGroup().addTo(map);
  const previewLayer = L.layerGroup().addTo(map);
  const pinIcon = (text, cls) => L.divIcon({
    className: '', html: `<div class="pin ${cls || ''}"><span>${esc(text)}</span></div>`,
    iconSize: [28, 28], iconAnchor: [14, 28], popupAnchor: [0, -26],
  });

  // ---------- Yardımcılar ----------
  function setProgress(msg, isErr) {
    el.progress.hidden = !msg; el.progress.textContent = msg || ''; el.progress.classList.toggle('err', !!isErr);
  }
  const fmtKm = (m) => (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
  function fmtDur(sec) {
    const min = Math.round(sec / 60);
    return min < 60 ? min + ' dk' : Math.floor(min / 60) + ' sa ' + (min % 60) + ' dk';
  }
  const fmtClock = (d) => d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const ll = (p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
  const travelmode = () => (el.profile.value === 'foot' ? 'walking' : 'driving');
  // Google Maps'e ne gönderilecek? Konumu kesin bilinmeyen (ücretsiz kaynaktan bulunmuş) duraklar için
  // ADRES METNİ gönderilir: kapı numarasını telefondaki Google Maps uygulaması kendisi bulur (ücretsiz).
  // Kesin konumlar (öneriden seçilen, haritada işaretlenen, Google'ın bulduğu, koordinat) koordinatla gider.
  function navText(raw) {
    let t = P.parseAddress(raw).display.replace(/[|~]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!P.lower(t).includes('izmir')) t += ', İzmir';
    return t;
  }
  const preciseGeo = (g) => g.picked || /^(Elle|Google|Koordinat)/.test(g.source || '');
  const navTarget = (p) => p.nav || ll(p);
  const gmapsTo = (p) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(navTarget(p)).replace(/%2C/g, ',')}&travelmode=${travelmode()}`;

  // Yandex adresi büyükten küçüğe sırayla en iyi anlıyor: "Türkiye, İzmir, ilçe, mahalle, sokak, no"
  // (Testte "Konak Meydanı, İzmir" yazınca İstanbul'daki bir sokağı bulmuştu; bu formatla doğru buluyor.)
  function yandexText(raw) {
    const p = P.parseAddress(raw);
    const d = G.districtOf(raw);
    const parts = p.street
      ? [p.mahalle, p.street, p.number]
      : [p.core.replace(new RegExp(d, 'i'), '').replace(/İzmir/gi, '').replace(/^[\s,]+|[\s,]+$/g, '')];
    return ['Türkiye', 'İzmir', d, ...parts].filter(Boolean).join(', ').replace(/~/g, ' ');
  }
  const yTarget = (p) => (p.nav ? yandexText(p.raw) : ll(p));
  const yandexUrl = (pts, fromHere) =>
    `https://yandex.com.tr/harita/?rtext=${fromHere ? '~' : ''}${pts.map((p) => encodeURIComponent(yTarget(p))).join('~')}&rtt=${el.profile.value === 'foot' ? 'pd' : 'auto'}`;
  const navApp = () => radio('navApp');
  // Tek durağa "Git" linki: seçili navigasyon uygulamasıyla, bulunduğun yerden
  const goTo = (p) => (navApp() === 'yandex' ? yandexUrl([p], true) : gmapsTo(p));

  // Çıkış saati: boşsa şimdi; geçmiş bir saatse yarın kabul edilir
  function departure() {
    const now = new Date();
    if (!el.depart.value) return now;
    const [h, m] = el.depart.value.split(':').map(Number);
    const d = new Date(now); d.setHours(h, m, 0, 0);
    if (d < now - 5 * 60000) d.setDate(d.getDate() + 1);
    return d < now ? now : d;
  }

  let regionCache = { text: null, value: null };
  async function getRegion() {
    const rt = el.region.value.trim(); // boşsa tüm İzmir
    if (regionCache.text !== rt) regionCache = { text: rt, value: await G.resolveRegion(rt).catch(() => G.CITY_REGION) };
    return regionCache.value;
  }

  // ---------- Adres listesi ----------
  function addRaw(list) {
    const have = new Set(items.map((i) => P.cacheKey(i.raw)));
    let added = 0;
    for (const raw of list) {
      const k = P.cacheKey(raw);
      if (!k || have.has(k)) continue;
      have.add(k); items.push({ id: uid(), raw, geo: null, status: 'pending' }); added++;
    }
    saveItems(); renderList(); geocodeQueue();
    return added;
  }
  function addResolved(text, geo) {
    if (items.some((i) => P.cacheKey(i.raw) === P.cacheKey(text))) return;
    G.saveFix(text, geo.lat, geo.lon, geo.label);
    items.push({ id: uid(), raw: text, geo: { ...geo, level: 'exact' }, status: 'ok', picked: true });
    saveItems(); renderList();
  }
  const statusOf = (geo) => (!geo ? 'missing' : geo.level === 'exact' ? 'ok' : 'approx');

  let queueP = null;
  function geocodeQueue() {
    if (queueP) return queueP;
    queueP = (async () => {
      const region = await getRegion();
      let item;
      while ((item = items.find((i) => i.status === 'pending'))) {
        item.status = 'working'; renderList();
        let geo = null;
        try { geo = await G.geocodeAddress(item.raw, region); } catch (e) { console.warn(e); }
        if (!items.includes(item)) continue; // bu arada silindiyse
        item.geo = geo; item.status = statusOf(geo);
        saveItems(); renderList();
      }
      if (GG.lastError) setProgress('Google adres araması çalışmadı (' + GG.lastError + '). Ücretsiz kaynaklar kullanıldı.', true);
    })().finally(() => { queueP = null; });
    return queueP;
  }

  // Diğer adreslerden çok uzakta bulunan sonuç büyük ihtimalle yanlış eşleşmedir: şüpheli işaretle
  function flagOutliers() {
    const all = items.filter((i) => i.geo);
    items.forEach((i) => { i.far = 0; });
    if (all.length < 4) return;
    const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const c = { lat: med(all.map((i) => i.geo.lat)), lon: med(all.map((i) => i.geo.lon)) };
    const lim = Math.max(15, 4 * med(all.map((i) => G.haversineKm(c, i.geo))));
    for (const i of all) {
      if (i.picked || /^Elle/.test(i.geo.source || '')) continue; // kullanıcının kendi seçtiği/işaretlediği konum
      const km = G.haversineKm(c, i.geo);
      if (km > lim) { i.far = Math.round(km); i.status = 'approx'; i.geo.level = 'area'; }
    }
  }

  function renderList() {
    flagOutliers();
    const c = { ok: 0, approx: 0, missing: 0, wait: 0 };
    for (const i of items) {
      if (i.status === 'ok') c.ok++; else if (i.status === 'approx') c.approx++;
      else if (i.status === 'missing') c.missing++; else c.wait++;
    }
    el.listSummary.innerHTML = items.length
      ? `<b>${items.length} adres</b>` + (c.missing ? ` · <span style="color:var(--err)">${c.missing} bulunamadı</span>` : '') +
        (c.wait ? ` · ${c.wait} aranıyor…` : '')
      : 'Henüz adres yok';
    el.empty.hidden = items.length > 0;
    el.listSummary.parentElement.hidden = items.length === 0;
    el.clear.hidden = items.length === 0;
    el.tabCount.textContent = items.length;
    if (!el.route.disabled) el.route.textContent = routeLabel();
    el.list.innerHTML = '';
    for (const it of items) {
      const li = document.createElement('li');
      const cls = { ok: 'ok', approx: 'warn', missing: 'bad' }[it.status] || 'wait';
      li.className = 'addr-row ' + cls;
      // Kullanıcıya teknik detay değil, yapılacak şey gösterilir
      const sub = it.far ? `⚠ ${it.far} km uzakta bulundu, büyük ihtimalle yanlış. Düzenle ya da 📍 ile işaretle.`
        : it.status === 'missing' ? 'Bulunamadı. Düzenle ✏️ ya da haritada işaretle 📍'
        : it.status === 'approx' ? 'Sokak bulundu. Kapıyı navigasyon uygulaması bulacak.'
        : it.geo ? (it.picked || /^Elle/.test(it.geo.source || '') ? 'Konum kesin' : 'Bulundu')
        : 'Aranıyor…';
      li.innerHTML = `<div class="st"></div>
        <div><div class="t">${esc(it.raw)}</div><div class="f">${esc(sub)}</div></div>
        <div class="acts">
          <button data-a="edit" title="Düzenle">✏️</button>
          <button data-a="pin" title="Haritada işaretle">📍</button>
          <button data-a="del" title="Sil">🗑</button>
        </div>`;
      li.querySelector('[data-a=del]').onclick = () => {
        items = items.filter((x) => x !== it); saveItems(); renderList();
      };
      li.querySelector('[data-a=pin]').onclick = () => startPick(it);
      li.querySelector('[data-a=edit]').onclick = () => editRow(li, it);
      li.querySelector('.t').onclick = () => {
        if (!it.geo) return;
        map.setView([it.geo.lat, it.geo.lon], 17);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };
      el.list.appendChild(li);
    }
    renderPreview();
  }

  function editRow(li, it) {
    if (li.querySelector('.edit')) return;
    const box = document.createElement('div');
    box.className = 'edit';
    box.innerHTML = `<div style="flex:1;position:relative"><input type="text"></div><button class="btn small">Ara</button>`;
    li.appendChild(box);
    const inp = box.querySelector('input');
    inp.value = it.raw; inp.focus(); inp.select();
    const reSearch = (text) => {
      G.clearFix(it.raw);
      it.raw = text; it.geo = null; it.status = 'pending';
      saveItems(); renderList(); geocodeQueue();
    };
    RB.autocomplete.attach(inp, {
      getRegion,
      onPick: (geo, text) => {
        G.clearFix(it.raw);
        it.raw = text; it.geo = { ...geo, level: 'exact' }; it.status = 'ok'; it.picked = true;
        G.saveFix(text, geo.lat, geo.lon, geo.label);
        saveItems(); renderList();
      },
      onEnter: reSearch,
    });
    box.querySelector('button').onclick = () => inp.value.trim() && reSearch(inp.value.trim());
  }

  // Rota oluşturulmadan önce listedeki adresleri haritada göster
  function renderPreview() {
    previewLayer.clearLayers();
    if (last) return;
    const b = [];
    items.forEach((it, i) => {
      if (!it.geo) return;
      L.marker([it.geo.lat, it.geo.lon], { icon: pinIcon(String(i + 1), it.status === 'approx' ? 'approx' : '') })
        .bindPopup(esc(it.raw)).addTo(previewLayer);
      b.push([it.geo.lat, it.geo.lon]);
    });
    if (b.length && !previewFitted) { map.fitBounds(b, { padding: [30, 30], maxZoom: 15 }); }
  }
  let previewFitted = false;

  // ---------- Haritada elle işaretleme ----------
  let picking = null;
  function startPick(it) {
    picking = it;
    el.banner.hidden = false;
    el.banner.textContent = `"${it.raw.slice(0, 50)}" için haritada doğru yere dokun (iptal: Esc)`;
    map.getContainer().style.cursor = 'crosshair';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function endPick() { picking = null; el.banner.hidden = true; map.getContainer().style.cursor = ''; }
  map.on('click', (e) => {
    if (!picking) return;
    const it = picking;
    G.saveFix(it.raw, e.latlng.lat, e.latlng.lng);
    it.geo = { lat: e.latlng.lat, lon: e.latlng.lng, label: 'Haritada işaretlendi', level: 'exact', source: 'Elle' };
    it.status = 'ok';
    endPick(); saveItems(); renderList();
    if (last) markDirty();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') endPick(); });

  // ---------- Rota oluşturma ----------
  let last = null;
  const routeLabel = () => (items.length ? `🚀 Rotayı oluştur · ${items.length} adres` : '🚀 Rotayı oluştur');
  function setBusy(b) {
    el.route.disabled = b; el.recalc.disabled = b;
    el.route.textContent = b ? '⏳ Hesaplanıyor…' : routeLabel();
  }

  // İki ekran: adresler / rota
  function setView(v) {
    document.body.dataset.view = v;
    document.querySelectorAll('.view').forEach((s) => { s.hidden = s.dataset.view !== v; });
    el.tabRoute.disabled = !last;
    window.scrollTo({ top: 0 });
    setTimeout(() => map.invalidateSize(), 300); // harita yüksekliği değişiyor
  }

  // Başlangıç boşsa telefonun konumu kullanılır (alınamazsa rota en uygun duraktan başlar)
  function currentPosition() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, raw: 'Bulunduğun yer', label: 'Bulunduğun yer',
          level: 'exact', source: 'Koordinat', isGps: true }),
        () => resolve(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
    });
  }

  async function resolvePoint(text, geo, region, what) {
    if (geo && text === geo.text) return { ...geo, raw: text };
    const g = await G.geocodeAddress(text, region);
    if (!g) throw new Error(`${what} bulunamadı: "${text}". Öneri listesinden seçmeyi dene.`);
    return { ...g, raw: text };
  }

  async function build() {
    saveSettings();
    if (!items.length) return setProgress('Önce adres ekle.', true);
    const mode = radio('endMode'), goal = GOALS[radio('goal')], profile = el.profile.value;
    const useTraffic = GG.enabled() && profile === 'driving';
    setBusy(true);
    try {
      if (queueP) { setProgress('Adres aramaları bitiyor…'); await queueP; }
      const region = await getRegion();

      let start = null;
      const st = el.start.value.trim();
      if (st) { setProgress('Başlangıç noktası bulunuyor…'); start = await resolvePoint(st, startGeo, region, 'Başlangıç adresi'); }
      else {
        setProgress('Konumun alınıyor…');
        start = await currentPosition();
        if (start && !G.insideCity(start)) start = null; // İzmir dışındaysan rota en uygun duraktan başlar
      }
      if (mode === 'return' && !start) throw new Error('"Başa dön" için konum izni ver ya da ayarlardan başlangıç adresi gir.');
      let end = null;
      if (mode === 'fixed') {
        const et = el.end.value.trim();
        if (!et) throw new Error('Bitiş adresini yaz.');
        end = await resolvePoint(et, endGeo, region, 'Bitiş adresi');
      }

      const ok = items.filter((i) => i.geo).map((i) => {
        const g = { ...i.geo, raw: i.raw, picked: i.picked };
        return { ...g, nav: preciseGeo(g) ? null : navText(i.raw) };
      });
      if (start && !start.isGps && !preciseGeo(startGeo && el.start.value === startGeo.text ? { ...start, picked: true } : start)) start.nav = navText(start.raw);
      if (end && !preciseGeo(endGeo && el.end.value === endGeo.text ? { ...end, picked: true } : end)) end.nav = navText(end.raw);
      const missing = items.filter((i) => !i.geo);
      if (!ok.length) throw new Error('Haritada konumu olan adres yok. Bulunamayanları düzenle ya da haritada işaretle.');

      const pts = [];
      const startIdx = start ? pts.push(start) - 1 : null;
      const stopIdx = ok.map((s) => pts.push(s) - 1);
      const endIdx = end ? pts.push(end) - 1 : null;
      const dep = departure();

      setProgress(`Yol mesafeleri hesaplanıyor (${ok.length} durak)…`);
      const base = await RB.routing.matrix(pts, profile);
      let mx = base, trafficInfo = null, trafficErr = null;
      if (useTraffic) {
        setProgress(`Trafik durumu alınıyor (${fmtClock(dep)} çıkışa göre)…`);
        try {
          mx = await GG.trafficMatrix(pts, base, {
            departure: dep > new Date(Date.now() + 60000) ? dep : null,
            canOrigin: (i) => i !== endIdx,
            canDest: (j) => j !== startIdx || mode === 'return',
          });
          trafficInfo = mx;
        } catch (e) { console.warn(e); trafficErr = e.message; }
      }

      const costM = (T, D) => T.map((row, i) => row.map((t, j) => t + goal.w * 60 * (D[i][j] / 1000)));
      const T = mx.durations.map((r) => r.slice()), D = mx.distances.map((r) => r.slice());
      const opts = { start: startIdx, end: endIdx, returnToStart: mode === 'return', stops: stopIdx };
      const tourCost = (C, seq) => {
        const full = [startIdx, ...seq, mode === 'return' ? startIdx : endIdx].filter((x) => x != null);
        let c = 0; for (let i = 0; i < full.length - 1; i++) c += C[full[i]][full[i + 1]];
        return c;
      };

      setProgress('En iyi sıra bulunuyor…');
      await new Promise((r) => setTimeout(r, 30));
      let order = RB.solver.solve(costM(T, D), opts);

      const routeFor = async (ord) => {
        const seq = [start, ...ord.map((i) => pts[i]), mode === 'return' ? start : end].filter(Boolean);
        if (seq.length < 2) return { line: [], legs: [], distance: 0, duration: 0 };
        if (useTraffic && !trafficErr) {
          try { return await GG.route(seq, dep); } catch (e) { console.warn(e); trafficErr = e.message; }
        }
        return RB.routing.route(seq, profile);
      };
      setProgress('Rota çiziliyor…');
      let rr = await routeFor(order);

      // İyileştirme: gerçek (trafikli) bacak sürelerini matrise yaz, tekrar çöz; daha iyiyse onu kullan
      if (useTraffic && !trafficErr && rr.traffic) {
        const full = [startIdx, ...order, mode === 'return' ? startIdx : endIdx].filter((x) => x != null);
        rr.legs.forEach((l, k) => { T[full[k]][full[k + 1]] = l.duration; D[full[k]][full[k + 1]] = l.distance; });
        const C2 = costM(T, D);
        const order2 = RB.solver.solve(C2, opts);
        if (order2.join() !== order.join() && tourCost(C2, order2) < tourCost(C2, order) * 0.98) {
          setProgress('Trafiğe göre sıra iyileştiriliyor…');
          const rr2 = await routeFor(order2);
          const realCost = (r) => r.duration + goal.w * 60 * r.distance / 1000;
          if (realCost(rr2) < realCost(rr)) { order = order2; rr = rr2; }
        }
      }

      // Girilen sırayla karşılaştırma (aynı maliyet matrisiyle)
      const sum = (M, seq) => tourCost(M, seq);
      const saved = { km: Math.max(0, sum(D, stopIdx) - sum(D, order)), sec: Math.max(0, sum(T, stopIdx) - sum(T, order)) };

      last = {
        start, end, mode, dep, orderedStops: order.map((i) => pts[i]), missing, route: rr, saved,
        traffic: !!rr.traffic, trafficErr, trafficInfo, useTraffic, approx: mx.approximate && !rr.traffic,
      };
      previewLayer.clearLayers();
      undoStack.length = 0;
      setProgress('');
      setView('route');
      render();
      saveRoute();
      updateGoogleCard();
    } catch (e) {
      console.error(e);
      setProgress(e.message || String(e), true);
    } finally { setBusy(false); }
  }

  // ---------- Sonuç çizimi ----------
  function render() {
    const R = last;
    routeLayer.clearLayers();
    const service = Math.max(0, +el.service.value || 0) * 60;
    const t0 = R.dep;

    if (R.route.line.length) L.polyline(R.route.line, { color: '#1f6feb', weight: 5, opacity: 0.8 }).addTo(routeLayer);
    const bounds = [];
    if (R.start) {
      L.marker([R.start.lat, R.start.lon], { icon: pinIcon('B', 'home'), zIndexOffset: 1000 })
        .bindPopup(`<b>Başlangıç</b><br>${esc(R.start.raw)}`).addTo(routeLayer);
      bounds.push([R.start.lat, R.start.lon]);
    }
    if (R.end) {
      L.marker([R.end.lat, R.end.lon], { icon: pinIcon('S', 'home') }).bindPopup(`<b>Bitiş</b><br>${esc(R.end.raw)}`).addTo(routeLayer);
      bounds.push([R.end.lat, R.end.lon]);
    }

    const legOffset = R.start ? 0 : -1;
    let t = 0;
    const rows = R.orderedStops.map((s, i) => {
      const leg = R.route.legs[i + legOffset];
      if (leg) t += leg.duration;
      const eta = new Date(t0.getTime() + t * 1000);
      t += service;
      return { s, i, leg, eta };
    });
    const totalDrive = R.route.duration, totalAll = totalDrive + service * R.orderedStops.length;

    rows.forEach((r) => {
      const { s, i, eta } = r;
      const approx = s.level !== 'exact';
      const m = L.marker([s.lat, s.lon], { icon: pinIcon(String(i + 1), approx ? 'approx' : ''), draggable: true }).addTo(routeLayer);
      r.marker = m;
      m.bindPopup(`<b>${i + 1}. ${esc(s.raw)}</b><br><small>${esc(s.label || '')}</small><br>
        <small>Varış ~${fmtClock(eta)}${approx ? ' · <b>yaklaşık konum</b>' : ''}</small><br>
        <a href="${goTo(s)}" target="_blank" rel="noopener">${NAV_NAMES[navApp()]} ile git ›</a><br>
        <small>Pin yanlışsa sürükleyip doğru yere bırak.</small>`);
      m.on('dragend', () => {
        const p = m.getLatLng();
        G.saveFix(s.raw, p.lat, p.lng);
        const it = items.find((x) => x.raw === s.raw);
        if (it) { it.geo = { lat: p.lat, lon: p.lng, label: 'Elle düzeltildi', level: 'exact', source: 'Elle' }; it.status = 'ok'; saveItems(); }
        s.lat = p.lat; s.lon = p.lng; s.level = 'exact'; s.nav = null; // artık elle işaretli koordinat kullanılır
        saveRoute(); refresh();
        markDirty();
      });
      bounds.push([s.lat, s.lon]);
    });
    R.rows = rows;
    const fit = () => bounds.length && map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
    fit(); setTimeout(fit, 350); // harita yüksekliği değiştikten sonra tekrar sığdır

    el.summary.innerHTML = `
      <div><b>${R.orderedStops.length}</b><span>durak</span></div>
      <div><b>${fmtKm(R.route.distance)}</b><span>toplam yol</span></div>
      <div><b>~${fmtClock(new Date(t0.getTime() + totalAll * 1000))}</b><span>bitiş · ${fmtDur(totalAll)}</span></div>`;

    const w = [];
    if (R.traffic) {
      const tr = R.trafficInfo ? R.trafficInfo.trafficRatio : 1;
      const lvl = tr > 1.6 ? 'yoğun' : tr > 1.25 ? 'orta' : 'akıcı';
      w.push(`<div class="okbox">🚦 Trafik hesaba katıldı (${fmtClock(R.dep)} çıkış, bölgede trafik <b>${lvl}</b>).</div>`);
    } else if (R.useTraffic && R.trafficErr) {
      w.push(`<div class="warnbox">Trafik verisi alınamadı (${esc(R.trafficErr)}). Rota trafiksiz hesaplandı.</div>`);
    } else if (el.profile.value === 'driving') {
      w.push(`<div class="muted">🚦 Durak sırası km'ye göre belirlendi. Duraklar arasındaki yolu, canlı trafiğe göre ${NAV_NAMES[navApp()]} seçer. Süreler trafiksiz tahmindir.</div>`);
    }
    if (R.saved.km > 300 || R.saved.sec > 120) w.push(`<div class="okbox">✓ Girdiğin sıraya göre <b>${fmtKm(R.saved.km)}</b> ve <b>${fmtDur(R.saved.sec)}</b> daha az.</div>`);
    if (R.approx) w.push('<div class="warnbox">Yol sunucusuna ulaşılamadı; mesafeler kuş uçuşu tahmindir.</div>');
    const approxCount = R.orderedStops.filter((s) => s.level !== 'exact').length;
    const textNav = R.orderedStops.filter((s) => s.nav).length;
    if (textNav) w.push(`<div class="okbox">📍 ${textNav} durak navigasyona adres olarak gönderiliyor; kapı numarasını ${NAV_NAMES[navApp()]} bulur.</div>`);
    if (approxCount) w.push(`<div class="warnbox">🟠 ${approxCount} adresin haritadaki yeri yaklaşık (sokak seviyesi); sıralama bu yerlere göre yapıldı. Bir pin belirgin şekilde yanlışsa sürükleyip düzelt, sonra "Yeniden hesapla".</div>`);
    if (R.missing.length) w.push(`<div class="errbox"><b>${R.missing.length} adres bulunamadığı için rotada yok:</b> ${R.missing.map((m) => esc(m.raw)).join(' · ')}<br>"1 · Adresler" sekmesinde düzenle ya da 📍 ile işaretle.</div>`);
    el.warnings.innerHTML = w.join('');
    // Önemli bir sorun varsa notlar açık gelsin, yoksa kapalı dursun
    const important = R.missing.length || (R.useTraffic && R.trafficErr) || R.approx;
    el.warnings.closest('details').open = !!important;
    el.warnCount.textContent = w.length;
    el.warnCount.hidden = !w.length;

    renderNav(R);

    el.stops.innerHTML = '';
    if (R.start) el.stops.appendChild(simpleRow('B', 'Başlangıç · ' + fmtClock(t0), R.start.raw, 'start'));
    rows.forEach((r) => {
      const { s, i, leg, eta } = r;
      const approx = s.level !== 'exact';
      const li = document.createElement('li');
      li.className = 'stop' + (approx ? ' approx' : '');
      li.innerHTML = `
        <div class="num">${i + 1}</div>
        <div>
          <div class="addr">${esc(s.raw)}</div>
          <div class="meta">${leg ? `+${fmtKm(leg.distance)} · ` : ''}varış ~${fmtClock(eta)}</div>
          <div class="badges"></div>
        </div>
        <div class="acts">
          <a class="go" href="${goTo(s)}" target="_blank" rel="noopener">Git</a>
          <div class="stat"></div>
        </div>`;
      li.addEventListener('click', (ev) => {
        if (ev.target.closest('a, .detail')) return;
        toggleDetail(r);
        map.setView([s.lat, s.lon], 16);
      });
      r.li = li;
      el.stops.appendChild(li);
    });
    if (R.mode === 'return' && R.start) el.stops.appendChild(simpleRow('B', 'Başlangıca dönüş', R.start.raw, 'end'));
    if (R.end) el.stops.appendChild(simpleRow('S', 'Bitiş', R.end.raw, 'end'));
    el.recalc.classList.remove('primary');
    refresh();
  }

  // Durak satırının altında: not, tahsilat, durum butonları
  function toggleDetail(r) {
    const open = r.li.querySelector('.detail');
    if (open) { open.remove(); return; }
    const it = itemOf(r.s.raw) || {};
    const d = document.createElement('div');
    d.className = 'detail';
    d.innerHTML = `
      <textarea placeholder="Not (örn: zili çalışmıyor, kapıcıya bırak)">${esc(it.note || '')}</textarea>
      <div class="grid2">
        <input type="text" inputmode="decimal" placeholder="Tahsilat ₺ (kapıda ödeme)" value="${it.amount ? esc(it.amount) : ''}">
        <button class="btn ghost" data-a="map">Haritada göster</button>
      </div>
      <div class="next-actions">
        <button class="btn ok" data-a="done">✓ Teslim edildi</button>
        <button class="btn fail" data-a="failed">✗ Edilemedi</button>
      </div>
      <button class="btn link small" data-a="clear">Durumu sıfırla</button>`;
    const [note, amount] = [d.querySelector('textarea'), d.querySelector('input')];
    const saveMeta = () => {
      const target = itemOf(r.s.raw);
      if (!target) return;
      target.note = note.value.trim(); target.amount = amount.value.trim();
      saveItems(); refresh();
    };
    note.addEventListener('change', saveMeta);
    amount.addEventListener('change', saveMeta);
    d.addEventListener('click', (ev) => {
      const a = ev.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      if (a === 'map') { map.setView([r.s.lat, r.s.lon], 17); r.marker.openPopup(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
      saveMeta();
      setStatus(r.s.raw, a === 'clear' ? null : a);
      d.remove(); refresh();
    });
    r.li.appendChild(d);
    note.focus();
  }

  // Durum değişince: satırlar, pinler, sıradaki durak kartı ve ilerleme çubuğu
  function refresh() {
    const R = last;
    if (!R || !R.rows) return;
    const st = getStatus();
    const stOf = (r) => st[P.cacheKey(r.s.raw)];
    let collected = 0, toCollect = 0, nDone = 0, nFail = 0;
    for (const r of R.rows) {
      const s = stOf(r);
      const it = itemOf(r.s.raw) || {};
      const money = parseMoney(it.amount);
      if (s === 'done') { nDone++; collected += money; } else if (s !== 'failed') toCollect += money;
      if (s === 'failed') nFail++;
      r.li.classList.toggle('done', s === 'done');
      r.li.classList.toggle('failed', s === 'failed');
      r.li.classList.remove('current');
      r.li.querySelector('.stat').textContent = s === 'done' ? '✓' : s === 'failed' ? '✗' : '';
      r.li.querySelector('.badges').innerHTML =
        (it.note ? `<span>📝 ${esc(it.note.length > 28 ? it.note.slice(0, 28) + '…' : it.note)}</span>` : '') +
        (money ? `<span class="money">💰 ${fmtMoney(money)}</span>` : '') +
        (s === 'failed' ? '<span style="color:var(--err)">teslim edilemedi</span>' : '');
      r.marker.setIcon(pinIcon(String(r.i + 1), s ? 'done' : r.s.level !== 'exact' ? 'approx' : ''));
    }

    const n = R.rows.length;
    const next = R.rows.find((r) => !stOf(r));
    el.nextCard.hidden = !next;
    el.finish.hidden = !!next;
    if (next) {
      const it = itemOf(next.s.raw) || {};
      const money = parseMoney(it.amount);
      next.li.classList.add('current');
      el.nextLabel.textContent = `SIRADAKİ DURAK · ${next.i + 1}/${n}`;
      el.nextAddr.textContent = next.s.raw;
      el.nextMeta.textContent = `Planlanan varış ~${fmtClock(next.eta)}` + (next.leg ? ` · önceki duraktan ${fmtKm(next.leg.distance)}` : '');
      el.nextExtra.innerHTML = (money ? `<div class="money">💰 Tahsil et: ${fmtMoney(money)}</div>` : '') +
        (it.note ? `<p class="note">📝 ${esc(it.note)}</p>` : '');
      el.nextGo.href = goTo(next.s);
      el.nextGo.textContent = `▶ Yol tarifi · ${NAV_NAMES[navApp()]}`;
      el.nextCard.dataset.raw = next.s.raw;
    } else {
      const failed = R.rows.filter((r) => stOf(r) === 'failed');
      el.finish.innerHTML = `<div class="big-emoji">🎉</div><b>Rota tamamlandı</b>
        <div class="muted">${nDone} teslim · ${nFail} edilemedi${collected ? ` · ${fmtMoney(collected)} tahsil edildi` : ''}</div>
        ${failed.length ? `<div class="muted" style="margin-top:6px">Edilemeyenleri tekrar denemek için listeden durağa dokunup "Durumu sıfırla"ya bas.</div>` : ''}`;
    }
    el.undo.hidden = !undoStack.length;

    el.doneFill.style.width = (n ? (nDone / n) * 100 : 0) + '%';
    el.failFill.style.width = (n ? (nFail / n) * 100 : 0) + '%';
    el.doneText.textContent = `${nDone}/${n} teslim` + (nFail ? ` · ${nFail} edilemedi` : '') +
      (collected || toCollect ? ` · 💰 ${fmtMoney(collected)}${toCollect ? ' / ' + fmtMoney(collected + toCollect) : ''}` : '');
  }

  // Sıradaki durak kartı butonları
  function actOnNext(status) {
    const raw = el.nextCard.dataset.raw;
    if (!raw) return;
    setStatus(raw, status);
    refresh();
    const next = last.rows.find((r) => !getStatus()[P.cacheKey(r.s.raw)]);
    if (next) map.setView([next.s.lat, next.s.lon], 15);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  el.nextDone.addEventListener('click', () => actOnNext('done'));
  el.nextFail.addEventListener('click', () => actOnNext('failed'));
  el.undo.addEventListener('click', () => {
    const u = undoStack.pop();
    if (!u) return;
    setStatus(u.raw, u.prev, false);
    refresh();
  });
  el.nextEdit.addEventListener('click', () => {
    const r = last && last.rows.find((x) => x.s.raw === el.nextCard.dataset.raw);
    if (!r) return;
    if (!r.li.querySelector('.detail')) toggleDetail(r);
    r.li.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // ---------- Rotanın kaydı: telefon sekmeyi yenilese de gün içinde kaybolmasın ----------
  const ROUTE = 'rb:route:v1';
  function saveRoute() {
    if (!last) return G.store.del(ROUTE);
    const { rows, trafficInfo, ...rest } = last;
    G.store.set(ROUTE, { day: today(), ...rest, dep: last.dep.toISOString(),
      trafficInfo: trafficInfo ? { trafficRatio: trafficInfo.trafficRatio } : null });
  }
  function loadRoute() {
    const r = G.store.get(ROUTE);
    if (!r || r.day !== today()) return null;
    return { ...r, dep: new Date(r.dep) };
  }

  function simpleRow(n, title, addr, cls) {
    const li = document.createElement('li');
    li.className = 'stop ' + cls;
    li.innerHTML = `<div class="num">${n}</div><div><div class="addr">${esc(title)}</div><div class="meta">${esc(addr)}</div></div><div></div>`;
    return li;
  }

  // Google Maps linki en fazla 9 ara durak alır: 10'arlı parçalara böl
  function renderNav(R) {
    const seq = [...R.orderedStops];
    if (R.mode === 'return' && R.start) seq.push(R.start);
    if (R.end) seq.push(R.end);
    // GPS ile başlıyorsa başlangıç gönderilmez: navigasyon canlı konumdan başlar
    const fromHere = !R.start || R.start.isGps;
    const startPt = fromHere ? null : R.start;

    // Bir link en fazla 10 durak taşır (Google'ın sınırı; Yandex için de aynı parçalama kullanılır)
    const chunks = [];
    for (let i = 0; i < seq.length; i += 10) chunks.push({ from: i + 1, to: Math.min(i + 10, R.orderedStops.length), pts: seq.slice(i, i + 10) });

    const googleUrl = (c, origin) => {
      const q = new URLSearchParams({ api: '1', destination: navTarget(c.pts[c.pts.length - 1]), travelmode: travelmode() });
      if (origin) q.set('origin', navTarget(origin));
      if (c.pts.length > 1) q.set('waypoints', c.pts.slice(0, -1).map(navTarget).join('|'));
      return `https://www.google.com/maps/dir/?${q.toString().replace(/%2C/g, ',').replace(/%7C/g, '|')}`;
    };
    const urlsFor = (app) => chunks.map((c, k) => {
      const origin = k === 0 ? startPt : chunks[k - 1].pts[chunks[k - 1].pts.length - 1];
      if (app === 'google') return googleUrl(c, origin);
      return origin ? yandexUrl([origin, ...c.pts], false) : yandexUrl(c.pts, true);
    });

    const app = navApp(), other = app === 'google' ? 'yandex' : 'google';
    const main = urlsFor(app), alt = urlsFor(other);
    const multi = chunks.length > 1;
    const html = main.map((u, k) => {
      const c = chunks[k];
      const label = !multi ? `▶ ${NAV_NAMES[app]}'te başlat`
        : k === 0 ? `▶ ${NAV_NAMES[app]}'te başlat · durak ${c.from}–${c.to}`
        : `Sonraki kısım · durak ${c.from}–${c.to}`;
      return `<a class="${k === 0 ? 'main' : ''}" href="${u}" target="_blank" rel="noopener">${label}</a>`;
    });
    if (multi) html.push(`<div class="hint">Bir link en fazla 10 durak alıyor. Bir kısım bitince sıradakini aç.</div>`);
    html.push(`<a class="alt" href="${alt[0]}" target="_blank" rel="noopener">${NAV_NAMES[other]} ile aç${multi ? ' (1. kısım)' : ''}</a>`);
    el.nav.innerHTML = html.join('');
  }

  function markDirty() {
    el.recalc.classList.add('primary');
    setProgress('Konum güncellendi. Rotaya yansıtmak için "Yeniden hesapla"ya bas.');
  }

  // ---------- Ekran görüntüsü / yapıştırma ----------
  function addFromText(text, source) {
    const { addresses, ignored } = P.pickAddresses(text);
    const n = addRaw(addresses);
    const skip = ignored.length ? ` ${ignored.length} satır adres gibi görünmediği için atlandı (${ignored.slice(0, 3).join(' · ')}${ignored.length > 3 ? '…' : ''}).` : '';
    const dup = addresses.length - n;
    return `✓ ${source}: ${n} adres eklendi.${dup ? ` ${dup} tanesi zaten listedeydi.` : ''}${skip}`;
  }

  async function handleImages(files) {
    files = [...files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    el.ocr.hidden = false; el.ocr.classList.remove('err');
    try {
      const text = await RB.ocr.readImages(files, (msg) => { el.ocr.textContent = msg; });
      if (!text) throw new Error('Görselde metin bulunamadı.');
      el.ocr.textContent = addFromText(text, `${files.length} görsel okundu`) + ' Listeyi kontrol et.';
    } catch (e) {
      console.error(e);
      el.ocr.textContent = 'Okuma hatası: ' + (e.message || e); el.ocr.classList.add('err');
    }
  }

  // ---------- Google ayar kartı ----------
  function updateGoogleCard() {
    const on = GG.enabled();
    el.gState.textContent = on ? 'Açık' : 'Kapalı';
    el.gState.classList.toggle('on', on);
    el.gKey.value = GG.getKey();
    const u = GG.usage();
    el.gUsage.innerHTML = on
      ? `Bu ay: ${u.matrixElements || 0} trafik ölçümü (ücretsiz ≈5.000) · ${u.routes || 0} rota (≈5.000) · ${(u.geocode || 0) + (u.places || 0)} adres araması (≈10.000).`
      : '';
  }
  el.gSave.addEventListener('click', async () => {
    GG.setKey(el.gKey.value);
    updateGoogleCard();
    if (!GG.enabled()) return setProgress('Google anahtarı kaldırıldı; ücretsiz kaynaklar kullanılacak.');
    setProgress('Anahtar deneniyor…');
    try {
      const r = await GG.findAddress('Konak Meydanı, İzmir', null);
      setProgress(r ? '✓ Google anahtarı çalışıyor. Rotalar artık trafikli hesaplanacak.' : 'Anahtar kabul edildi ama sonuç gelmedi.');
      // Daha önce ücretsiz kaynakla yaklaşık/bulunamayan adresleri Google ile tekrar dene
      items.forEach((i) => { if (i.status !== 'ok') { i.status = 'pending'; } });
      geocodeQueue();
    } catch (e) {
      setProgress('Anahtar çalışmadı: ' + e.message + ' (Places API (New) ve Routes API etkin mi, anahtar bu siteye izin veriyor mu?)', true);
    }
  });

  // ---------- Olaylar ----------
  RB.autocomplete.attach(el.quick, {
    getRegion,
    onPick: (geo, text) => { addResolved(text, geo); el.quick.value = ''; },
    onEnter: (text) => { addRaw([text]); el.quick.value = ''; },
  });
  el.quickBtn.addEventListener('click', () => { const t = el.quick.value.trim(); if (t) { addRaw([t]); el.quick.value = ''; } });

  const startAc = RB.autocomplete.attach(el.start, {
    getRegion,
    onPick: (geo, text) => { startGeo = { ...geo, text }; saveSettings(); },
  });
  RB.autocomplete.attach(el.end, {
    getRegion,
    onPick: (geo, text) => { endGeo = { ...geo, text }; saveSettings(); },
  });
  el.start.addEventListener('input', () => { if (startGeo && el.start.value !== startGeo.text) startGeo = null; saveSettings(); });
  el.end.addEventListener('input', () => { if (endGeo && el.end.value !== endGeo.text) endGeo = null; saveSettings(); });

  el.bulkToggle.addEventListener('click', () => { el.bulkBox.hidden = !el.bulkBox.hidden; if (!el.bulkBox.hidden) el.addr.focus(); });
  el.addr.addEventListener('input', () => {
    const { addresses, ignored } = P.pickAddresses(el.addr.value);
    el.bulkCount.textContent = el.addr.value.trim() ? `${addresses.length} adres` + (ignored.length ? ` · ${ignored.length} satır atlanacak` : '') : '';
  });
  el.bulkAdd.addEventListener('click', () => {
    if (!el.addr.value.trim()) return;
    el.ocr.hidden = false; el.ocr.classList.remove('err');
    el.ocr.textContent = addFromText(el.addr.value, 'Yapıştırılan metin');
    el.addr.value = ''; el.bulkCount.textContent = ''; el.bulkBox.hidden = true;
  });
  el.clear.addEventListener('click', () => {
    if (items.length && !confirm(`${items.length} adreslik liste silinsin mi?`)) return;
    items = []; last = null; previewFitted = false; saveItems(); saveRoute(); renderList();
    undoStack.length = 0;
    G.store.del(statusKey()); // bugünün teslim işaretleri de sıfırlanır
    routeLayer.clearLayers(); setView('addresses');
  });

  el.route.addEventListener('click', build);
  el.recalc.addEventListener('click', build);
  [el.region, el.service, el.profile, el.depart].forEach((x) => x.addEventListener('change', saveSettings));
  el.region.addEventListener('change', () => { items.forEach((i) => { if (i.status !== 'ok') i.status = 'pending'; }); geocodeQueue(); });
  document.querySelectorAll('input[name=endMode]').forEach((r) => r.addEventListener('change', () => {
    el.end.hidden = radio('endMode') !== 'fixed'; saveSettings();
  }));
  const showGoal = () => { el.goalHint.textContent = GOALS[radio('goal')].hint; };
  document.querySelectorAll('input[name=goal]').forEach((r) => r.addEventListener('change', () => { showGoal(); saveSettings(); }));
  // Navigasyon uygulaması değişince rota ekranındaki linkler hemen güncellensin
  document.querySelectorAll('input[name=navApp]').forEach((r) => r.addEventListener('change', () => { saveSettings(); if (last) render(); }));
  el.end.addEventListener('change', saveSettings);

  el.tabAddr.addEventListener('click', () => setView('addresses'));
  el.tabRoute.addEventListener('click', () => { if (last) setView('route'); });

  el.gps.addEventListener('click', () => {
    if (!navigator.geolocation) return setProgress('Tarayıcın konum desteklemiyor.', true);
    el.gps.disabled = true;
    navigator.geolocation.getCurrentPosition((pos) => {
      const text = '📍 Mevcut konumum';
      startGeo = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: text, level: 'exact', text, isGps: true };
      el.start.value = text; el.gps.disabled = false; startAc.close();
      map.setView([startGeo.lat, startGeo.lon], 14); saveSettings();
    }, (err) => { el.gps.disabled = false; setProgress('Konum alınamadı: ' + err.message, true); },
    { enableHighAccuracy: true, timeout: 15000 });
  });

  el.pick.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', () => { handleImages(el.file.files); el.file.value = ''; });
  ['dragenter', 'dragover'].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.remove('over'); }));
  el.drop.addEventListener('drop', (e) => handleImages(e.dataTransfer.files));

  // Sayfada her yerde Ctrl+V: görselse OCR, metinse doğrudan listeye ekle (bir alana yazarken normal yapıştırma)
  document.addEventListener('paste', (e) => {
    const imgs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (imgs.length) { e.preventDefault(); handleImages(imgs); return; }
    // Adres kutusuna çok satırlı liste yapıştırılırsa: her satır ayrı adres olarak eklenir
    if (e.target === el.quick) {
      const t = e.clipboardData?.getData('text') || '';
      if (t.includes('\n')) {
        e.preventDefault();
        el.ocr.hidden = false; el.ocr.classList.remove('err');
        el.ocr.textContent = addFromText(t, 'Yapıştırılan liste');
      }
      return;
    }
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    const text = e.clipboardData?.getData('text') || '';
    if (text.trim()) {
      e.preventDefault();
      el.ocr.hidden = false; el.ocr.classList.remove('err');
      el.ocr.textContent = addFromText(text, 'Yapıştırılan metin');
    }
  });

  el.copy.addEventListener('click', async () => {
    if (!last) return;
    const lines = last.orderedStops.map((s, i) => `${i + 1}. ${s.raw}\n   ${goTo(s)}`);
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      el.copy.textContent = '✓ Kopyalandı';
      setTimeout(() => (el.copy.textContent = 'Listeyi kopyala'), 1500);
    } catch { setProgress('Kopyalanamadı (tarayıcı izin vermedi).', true); }
  });

  // ---------- Başlat ----------
  loadSettings();
  el.end.hidden = radio('endMode') !== 'fixed';
  showGoal();
  updateSettingsSummary();
  updateGoogleCard();
  last = loadRoute(); // bugün oluşturulmuş rota varsa kaldığın yerden devam
  setView(last ? 'route' : 'addresses');
  renderList();
  if (last) render();
  previewFitted = items.some((i) => i.geo);
  if (items.some((i) => i.status === 'pending')) geocodeQueue();
})(window.RB);
