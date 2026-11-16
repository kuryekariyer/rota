// Adres -> koordinat. Önce Nominatim (OSM, katı eşleşme), olmazsa Photon (OSM, esnek eşleşme).
// Sonuçlar tarayıcıda saklanır; aynı adres ertesi gün anında bulunur.
// Haritada elle düzeltilen pinler de saklanır ve her zaman önceliklidir.
window.RB = window.RB || {};

(function (RB) {
  const P = RB.parse;
  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  const PHOTON = 'https://photon.komoot.io/api/';
  const CACHE_PREFIX = 'rb:geo:v1:';
  const FIX_PREFIX = 'rb:fix:v1:';

  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* dolu/kapalı */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* yok say */ } },
  };

  // Nominatim kullanım kuralı: saniyede en fazla 1 istek
  let lastNominatim = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function throttle() {
    const wait = lastNominatim + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastNominatim = Date.now();
  }

  function levelFromRank(rank) {
    if (rank >= 29) return 'exact';
    if (rank >= 26) return 'street';
    return 'area';
  }

  async function nominatim(q, region) {
    const key = CACHE_PREFIX + 'n2:' + P.cacheKey(q) + (region ? '|' + region.key : '');
    const cached = store.get(key);
    if (cached) return cached.hit || null;

    const params = new URLSearchParams({
      q, format: 'jsonv2', limit: '1', countrycodes: 'tr', addressdetails: '1', 'accept-language': 'tr',
    });
    if (region && region.viewbox) { params.set('viewbox', region.viewbox); params.set('bounded', '1'); }
    await throttle();
    const res = await fetch(`${NOMINATIM}?${params}`);
    if (!res.ok) throw new Error('Nominatim ' + res.status);
    const data = await res.json();
    const r = data[0];
    const hit = r ? {
      lat: +r.lat, lon: +r.lon, label: r.display_name, level: levelFromRank(r.place_rank || 0), source: 'Nominatim',
      bbox: r.boundingbox ? r.boundingbox.map(Number) : null,
      // Sonucun gerçekten bulunduğu sokak (mekân adı değil)
      street: (r.address && (r.address.road || r.address.pedestrian || r.address.footway)) || (r.category === 'highway' ? r.name : ''),
      hn: (r.address && r.address.house_number) || '',
    } : null;
    store.set(key, { hit });
    return hit;
  }

  async function photon(q, region) {
    const key = CACHE_PREFIX + 'p4:' + P.cacheKey(q) + (region ? '|' + region.key : '');
    const cached = store.get(key);
    if (cached) return cached.hit || null;

    const params = new URLSearchParams({ q, limit: '5' });
    if (region) {
      params.set('lat', region.lat); params.set('lon', region.lon);
      if (region.bboxPhoton) params.set('bbox', region.bboxPhoton);
    }
    const res = await fetch(`${PHOTON}?${params}`);
    if (!res.ok) throw new Error('Photon ' + res.status);
    const data = await res.json();
    const f = (data.features || []).find((x) => x.properties && x.properties.countrycode === 'TR') || null;
    let hit = null;
    if (f) {
      const pr = f.properties;
      const t = pr.type;
      const level = t === 'house' ? 'exact' : t === 'street' ? 'street' : 'area';
      const label = [pr.name, pr.street && pr.housenumber ? pr.street + ' ' + pr.housenumber : pr.street,
        pr.district, pr.county, pr.city, pr.state].filter(Boolean).join(', ');
      hit = { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label, level, source: 'Photon',
        street: [pr.street, pr.name].filter(Boolean).join(' '), hn: pr.housenumber || '' };
    }
    store.set(key, { hit });
    return hit;
  }

  function haversineKm(a, b) {
    const R = 6371, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // ---- Çalışma alanı: sadece İzmir ili ----
  const CITY = 'İzmir';
  const CITY_BOX = { s: 37.80, n: 39.40, w: 26.20, e: 28.50 }; // İzmir il sınırlarını kapsayan kutu
  const insideCity = (p) => p && p.lat >= CITY_BOX.s && p.lat <= CITY_BOX.n && p.lon >= CITY_BOX.w && p.lon <= CITY_BOX.e;
  const CITY_REGION = {
    text: CITY, key: P.cacheKey(CITY), lat: 38.4237, lon: 27.1428,
    viewbox: `${CITY_BOX.w},${CITY_BOX.n},${CITY_BOX.e},${CITY_BOX.s}`,
    bboxPhoton: `${CITY_BOX.w},${CITY_BOX.s},${CITY_BOX.e},${CITY_BOX.n}`,
    bounds: [[CITY_BOX.s, CITY_BOX.w], [CITY_BOX.n, CITY_BOX.e]],
    radiusKm: 120, isCity: true,
  };

  // İlçe verilirse (örn. "Bornova") aramayı o ilçeye odaklar; boşsa tüm İzmir
  async function resolveRegion(text) {
    let t = (text || '').trim();
    if (!t || P.cacheKey(t) === P.cacheKey(CITY)) return CITY_REGION;
    if (!P.lower(t).includes(P.lower(CITY))) t = `${t}, ${CITY}`;
    const hit = await nominatim(t, CITY_REGION);
    if (!hit || !insideCity(hit)) return CITY_REGION;
    let [s, n, w, e] = hit.bbox || [hit.lat - 0.1, hit.lat + 0.1, hit.lon - 0.1, hit.lon + 0.1];
    // Kutuyu biraz genişlet (ilçe sınırındaki adresler kaçmasın), çok küçükse min ~8 km yap
    const padLat = Math.max((n - s) * 0.25, 0.04), padLon = Math.max((e - w) * 0.25, 0.05);
    s -= padLat; n += padLat; w -= padLon; e += padLon;
    return {
      text: t, key: P.cacheKey(t), lat: hit.lat, lon: hit.lon,
      viewbox: `${w},${n},${e},${s}`,
      bboxPhoton: `${w},${s},${e},${n}`,
      bounds: [[s, w], [n, e]],
      radiusKm: Math.max(haversineKm({ lat: s, lon: w }, { lat: n, lon: e }) / 2, 5),
    };
  }

  // Girilen sokak adındaki ayırt edici kelimelerden en az biri sonuçta geçiyor mu?
  // (ilk 5 harf karşılaştırılır: "Tayyareci" ~ "Tayyareci Sami Sokak", ek farklarını tolere eder)
  const GENERIC = new Set(['sokak', 'sokağı', 'caddesi', 'cadde', 'bulvarı', 'yolu', 'meydanı', 'mahallesi', 'küme', 'evleri']);
  function streetMatches(street, text) {
    // Numaralı sokak (İzmir: "372. Sokak", "1203/1 Sokak"): numara birebir aynı olmalı ("372/5" ≠ "372")
    const num = (street.match(/(?<![\d\/])(\d+(?:\/\d+)?)(?![\d\/])/) || [])[1];
    if (num && /^\s*\d/.test(street)) {
      const re = new RegExp(`(?<![\\d/])${num.replace('/', '\\/')}(?![\\d/])`);
      return re.test(text || '');
    }
    const norm = (s) => P.lower(s || '').replace(/[^\p{L}\d ]+/gu, ' ');
    const words = norm(text).split(/\s+/).filter(Boolean);
    const toks = norm(street).split(/\s+/).filter((w) => w.length >= 3 && !GENERIC.has(w));
    if (!toks.length) return true;
    return toks.some((t) => words.some((w) => w.slice(0, 5) === t.slice(0, 5) || (/^\d+$/.test(t) && w === t)));
  }

  // İzmir dışı her sonuç reddedilir; ilçe seçiliyse ilçeden çok uzak sonuçlar da
  function insideRegion(hit, region) {
    if (!insideCity(hit)) return false;
    if (!region || region.isCity) return true;
    return haversineKm(hit, region) <= region.radiusKm * 1.5;
  }

  // Tek bir adresi çözer. onStep: ilerleme mesajı için
  async function geocodeAddress(raw, region) {
    const direct = P.parseCoords(raw);
    if (direct) return { ...direct, label: 'Koordinat', level: 'exact', source: 'Koordinat' };

    const fix = store.get(FIX_PREFIX + P.cacheKey(raw));
    if (fix) return { ...fix, level: 'exact', source: 'Elle düzeltildi' };

    const parsed = P.parseAddress(raw);
    const variants = P.queryVariants(parsed, region && region.text);
    let fallback = null;

    // 0) Google (anahtar varsa): dağınık Türkçe adreslerde en isabetli kaynak
    if (RB.google && RB.google.enabled()) {
      const gk = CACHE_PREFIX + 'g:' + P.cacheKey(raw) + (region ? '|' + region.key : '');
      let hit = (store.get(gk) || {}).hit;
      if (hit === undefined) {
        const q = region ? P.queryVariants({ core: parsed.display }, region.text)[0] || parsed.display : parsed.display;
        try {
          hit = await RB.google.findAddress(q, region);
          store.set(gk, { hit });
          RB.google.lastError = null;
        } catch (e) {
          console.warn(e);
          RB.google.lastError = e.message; // anahtar hatası vb. -> ücretsiz kaynaklarla devam
          hit = null;
        }
      }
      // Google başka bir sokağa/ilçeye eşlediyse güvenme: sadece yedek (yaklaşık) sonuç say
      if (hit && parsed.street && !streetMatches(parsed.street, hit.label)) hit = { ...hit, level: 'area' };
      if (hit && !districtMatches(parsed, hit.label)) hit = { ...hit, level: 'area' };
      if (hit && insideRegion(hit, region)) {
        if (hit.level !== 'area') return { ...hit, query: raw };
        fallback = { ...hit, query: raw };
      }
    }

    // Ücretsiz kaynak sonucu güvenilir mi? Sokak + ilçe tutmalı; kapı no farklıysa "sokak seviyesi"
    const check = (hit, streetText) => {
      if (!hit || !insideRegion(hit, region)) return null;
      if (parsed.street && !streetMatches(parsed.street, streetText)) return null;
      if (!districtMatches(parsed, hit.label)) return null;
      if (hit.level === 'exact' && parsed.number && P.lower(hit.hn || '') !== P.lower(parsed.number)) return { ...hit, level: 'street' };
      return hit;
    };

    // 1) Photon (hızlı, istek sınırı yok): tutarlı bir kapı/sokak sonucu verirse hemen kabul
    const ctx = region ? region.text : CITY;
    const photonQueries = [parsed.street && `${parsed.street} ${parsed.number}`.trim(), parsed.core]
      .filter(Boolean).map((q) => P.queryVariants({ core: q }, ctx)[0] || q);
    for (const q of [...new Set(photonQueries)]) {
      let hit = null;
      try { const h = await photon(q, region); hit = check(h, h && (h.street || h.label)); } catch (e) { console.warn(e); }
      if (hit && hit.level === 'exact') return { ...hit, query: q };
      if (hit && hit.level === 'street') { fallback = rankBetter(hit, fallback) ? { ...hit, query: q } : fallback; break; }
      if (hit && !fallback) fallback = { ...hit, query: q };
    }

    // 2) Nominatim (katı ama saniyede 1 istek): kapı numarası bulabilirse ya da Photon hiç bulamadıysa
    for (const q of variants) {
      const hasStreet = parsed.street && q.includes(parsed.street);
      // Elimizde sokak seviyesi sonuç varsa sadece kapı numaralı sorguyu dene
      if (fallback && fallback.level === 'street' && !(hasStreet && parsed.number && q.includes(parsed.number))) continue;
      if (fallback && fallback.level === 'area' && !hasStreet) continue;
      let hit = null;
      try { hit = await nominatim(q, region); } catch (e) { console.warn(e); }
      hit = check(hit, hasStreet ? hit && hit.street : hit && hit.label);
      if (!hit) continue;
      if (hit.level === 'exact') return { ...hit, query: q };
      if (rankBetter(hit, fallback)) fallback = { ...hit, query: q };
      if (hit.level === 'street' && !parsed.number) break;
    }

    return fallback || null;
  }

  const RANK = { exact: 3, street: 2, area: 1 };
  const rankBetter = (a, b) => !b || (RANK[a.level] || 0) > (RANK[b.level] || 0);

  // Adreste ilçe yazıyorsa (örn. "Bayraklı") sonuç da o ilçede olmalı:
  // İzmir'de "1203/1 Sokak" gibi numaralı sokaklar birden fazla ilçede var.
  const DISTRICTS = ['aliağa', 'balçova', 'bayındır', 'bayraklı', 'bergama', 'beydağ', 'bornova', 'buca', 'çeşme', 'çiğli',
    'dikili', 'foça', 'gaziemir', 'güzelbahçe', 'karabağlar', 'karaburun', 'karşıyaka', 'kemalpaşa', 'kınık', 'kiraz',
    'konak', 'menderes', 'menemen', 'narlıdere', 'ödemiş', 'seferihisar', 'selçuk', 'tire', 'torbalı', 'urla'];
  // Metinde geçen ilk ilçe adını düzgün yazımıyla döndürür (Yandex adres formatı için)
  const DISTRICT_NAMES = ['Aliağa', 'Balçova', 'Bayındır', 'Bayraklı', 'Bergama', 'Beydağ', 'Bornova', 'Buca', 'Çeşme', 'Çiğli',
    'Dikili', 'Foça', 'Gaziemir', 'Güzelbahçe', 'Karabağlar', 'Karaburun', 'Karşıyaka', 'Kemalpaşa', 'Kınık', 'Kiraz',
    'Konak', 'Menderes', 'Menemen', 'Narlıdere', 'Ödemiş', 'Seferihisar', 'Selçuk', 'Tire', 'Torbalı', 'Urla'];
  function districtOf(text) {
    const t = P.lower(text || '');
    return DISTRICT_NAMES.find((d) => new RegExp(`(?<![\\p{L}])${P.lower(d)}(?![\\p{L}])`, 'u').test(t)) || '';
  }

  function districtMatches(parsed, label) {
    const text = P.lower(parsed.rest + ' ' + parsed.raw);
    const named = DISTRICTS.filter((d) => new RegExp(`(?<![\\p{L}])${d}(?![\\p{L}])`, 'u').test(text));
    if (!named.length) return true;
    const l = P.lower(label || '');
    return named.some((d) => l.includes(d));
  }

  function saveFix(raw, lat, lon, label) {
    store.set(FIX_PREFIX + P.cacheKey(raw), { lat, lon, label: label || 'Elle işaretlendi' });
  }
  function clearFix(raw) { store.del(FIX_PREFIX + P.cacheKey(raw)); }

  // Anahtarsız modda yazarken öneri (Photon)
  async function suggestFree(input, region) {
    const r = region || CITY_REGION;
    const params = new URLSearchParams({ q: input, limit: '6', lat: r.lat, lon: r.lon, bbox: CITY_REGION.bboxPhoton });
    const res = await fetch(`${PHOTON}?${params}`);
    const data = await res.json();
    return (data.features || []).filter((f) => f.properties.countrycode === 'TR').map((f) => {
      const p = f.properties;
      const main = [p.name || p.street, p.housenumber].filter(Boolean).join(' ');
      const sub = [p.name && p.street ? p.street : '', p.district, p.city || p.county].filter(Boolean).join(', ');
      return {
        main: main || sub, sub, text: [main, sub].filter(Boolean).join(', '),
        geo: { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label: [main, sub].filter(Boolean).join(', '),
          level: p.type === 'house' ? 'exact' : p.type === 'street' ? 'street' : 'area', source: 'Photon' },
      };
    });
  }

  RB.geo = { geocodeAddress, suggestFree, districtOf, CITY, CITY_BOX, CITY_REGION, insideCity, resolveRegion, saveFix, clearFix, haversineKm, store };
})(window.RB);
