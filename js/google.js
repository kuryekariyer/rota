// Google Maps Platform (isteğe bağlı API anahtarı ile):
// - Adres bulma (Geocoding + Places Text Search): Türkçe/dağınık adreslerde çok daha isabetli
// - Yazarken adres önerisi (Places Autocomplete)
// - Canlı/tahmini TRAFİKLİ süre (Routes API)
// Anahtar sadece bu tarayıcıda saklanır.
window.RB = window.RB || {};

(function (RB) {
  const KEY = 'rb:gkey';
  const getKey = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
  const setKey = (k) => { try { k ? localStorage.setItem(KEY, k.trim()) : localStorage.removeItem(KEY); } catch { /* */ } };
  const enabled = () => !!getKey();

  // ---- Aylık kullanım sayacı (Google'ın ücretsiz kotalarını aşmamak için) ----
  const usageKey = () => 'rb:gusage:' + new Date().toISOString().slice(0, 7);
  function track(kind, n = 1) {
    const u = RB.geo.store.get(usageKey()) || {};
    u[kind] = (u[kind] || 0) + n;
    RB.geo.store.set(usageKey(), u);
  }
  const usage = () => RB.geo.store.get(usageKey()) || {};

  async function post(url, body, fieldMask) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': getKey(), 'X-Goog-FieldMask': fieldMask },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = Array.isArray(data) ? data[0]?.error : data?.error;
      throw new Error('Google: ' + (err?.message || res.status));
    }
    return data;
  }

  const latLng = (p) => ({ latLng: { latitude: p.lat, longitude: p.lon } });
  const secs = (s) => (s ? parseFloat(String(s).replace('s', '')) : 0);

  // Arama ve öneriler İzmir il sınırıyla KISITLANIR (başka şehirden sonuç gelmez)
  function cityRestriction() {
    const b = RB.geo.CITY_BOX;
    return { rectangle: { low: { latitude: b.s, longitude: b.w }, high: { latitude: b.n, longitude: b.e } } };
  }

  // ---- Adres bulma ----
  async function geocode(text, region) {
    const params = new URLSearchParams({ address: text, key: getKey(), language: 'tr', region: 'tr', components: 'country:TR' });
    if (region) {
      const [[s, w], [n, e]] = region.bounds;
      params.set('bounds', `${s},${w}|${n},${e}`);
    }
    const res = await fetch('https://maps.googleapis.com/maps/api/geocode/json?' + params);
    const data = await res.json();
    track('geocode');
    if (data.status === 'REQUEST_DENIED') throw new Error('Google: ' + (data.error_message || 'anahtar reddedildi'));
    const r = data.results && data.results[0];
    if (!r) return null;
    const lt = r.geometry.location_type;
    const t = r.types || [];
    const level = lt === 'ROOFTOP' || lt === 'RANGE_INTERPOLATED' || t.includes('street_address') || t.includes('premise')
      ? 'exact' : t.includes('route') ? 'street' : 'area';
    return { lat: r.geometry.location.lat, lon: r.geometry.location.lng, label: r.formatted_address, level, source: 'Google' };
  }

  async function textSearch(text, region) {
    const body = { textQuery: text, languageCode: 'tr', regionCode: 'TR', pageSize: 1, locationRestriction: cityRestriction() };
    const data = await post('https://places.googleapis.com/v1/places:searchText', body,
      'places.location,places.formattedAddress,places.types');
    track('places');
    const p = data.places && data.places[0];
    if (!p) return null;
    const t = p.types || [];
    // Kapı numarası sonuçta geçiyorsa veya bina/adres tipindeyse tam isabet
    const hasNo = /No\s*:?\s*\d/i.test(p.formattedAddress || '');
    const level = hasNo || t.some((x) => ['street_address', 'premise', 'subpremise', 'establishment', 'point_of_interest'].includes(x))
      ? 'exact' : t.includes('route') ? 'street' : 'area';
    return { lat: p.location.latitude, lon: p.location.longitude, label: p.formattedAddress, level, source: 'Google' };
  }

  // Adres bulma Places Text Search (New) ile: kapı numaralı Türkçe adreslerde isabetli ve
  // "sadece bu site" kısıtlı anahtarla tarayıcıdan çalışır (Geocoding web servisi bunu desteklemez).
  async function findAddress(text, region) {
    return textSearch(text, region);
  }

  // ---- Yazarken öneri ----
  let session = null;
  const newSession = () => (session = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
  async function suggest(input, region) {
    if (!session) newSession();
    const body = { input, languageCode: 'tr', includedRegionCodes: ['tr'], sessionToken: session, locationRestriction: cityRestriction() };
    const data = await post('https://places.googleapis.com/v1/places:autocomplete', body,
      'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat');
    return (data.suggestions || []).filter((s) => s.placePrediction).map((s) => ({
      id: s.placePrediction.placeId,
      main: s.placePrediction.structuredFormat?.mainText?.text || s.placePrediction.text.text,
      sub: s.placePrediction.structuredFormat?.secondaryText?.text || '',
      text: s.placePrediction.text.text,
    }));
  }
  async function details(placeId) {
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=tr&sessionToken=${session || ''}`, {
      headers: { 'X-Goog-Api-Key': getKey(), 'X-Goog-FieldMask': 'location,formattedAddress,types' },
    });
    const p = await res.json();
    if (!res.ok) throw new Error('Google: ' + (p.error?.message || res.status));
    session = null; // oturum seçimle kapanır
    track('places');
    return { lat: p.location.latitude, lon: p.location.longitude, label: p.formattedAddress, level: 'exact', source: 'Google' };
  }

  // ---- Trafikli süre: seyrek matris ----
  // Her nokta için sadece EN YAKIN k komşuya trafikli süre sorulur (optimal rota zaten neredeyse
  // hep yakın komşular arasından geçer). Diğer çiftler, o bölgede ölçülen trafik oranıyla tahmin edilir.
  // 30 durakta ~120-150 öğe -> günlük kullanımda Google'ın ücretsiz aylık kotasına yakın kalır.
  async function trafficMatrix(pts, base, opts) {
    const n = pts.length;
    const k = Math.max(3, Math.min(n - 1, Math.floor(150 / n)));
    const T = base.durations.map((r) => r.slice());
    const D = base.distances.map((r) => r.slice());
    const measured = Array.from({ length: n }, () => new Array(n).fill(false));
    const ratios = Array.from({ length: n }, () => []);

    const jobs = [];
    for (let i = 0; i < n; i++) {
      if (!opts.canOrigin(i)) continue;
      const dests = [...Array(n).keys()].filter((j) => j !== i && opts.canDest(j))
        .sort((a, b) => base.durations[i][a] - base.durations[i][b]).slice(0, k);
      if (dests.length) jobs.push({ i, dests });
    }

    const body = (job) => ({
      origins: [{ waypoint: { location: latLng(pts[job.i]) } }],
      destinations: job.dests.map((j) => ({ waypoint: { location: latLng(pts[j]) } })),
      travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', languageCode: 'tr',
      ...(opts.departure ? { departureTime: opts.departure.toISOString() } : {}),
    });
    let elements = 0, failed = 0;
    const run = async (job) => {
      try {
        const rows = await post('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', body(job),
          'originIndex,destinationIndex,duration,distanceMeters,condition');
        elements += job.dests.length;
        for (const r of rows) {
          if (r.condition !== 'ROUTE_EXISTS') continue;
          const j = job.dests[r.destinationIndex || 0];
          const dur = secs(r.duration);
          if (base.durations[job.i][j] > 30) ratios[job.i].push(dur / base.durations[job.i][j]);
          T[job.i][j] = dur;
          D[job.i][j] = r.distanceMeters ?? D[job.i][j];
          measured[job.i][j] = true;
        }
      } catch (e) {
        failed++;
        if (/key|anahtar|PERMISSION|denied|not valid/i.test(e.message)) throw e;
        console.warn(e);
      }
    };
    // Aynı anda en fazla 6 istek
    for (let s = 0; s < jobs.length; s += 6) await Promise.all(jobs.slice(s, s + 6).map(run));
    track('matrixElements', elements);
    if (!elements) throw new Error('Google trafik verisi alınamadı');

    // Ölçülmeyen çiftler: başlangıç ve varış noktasının bölgesel trafik oranlarının ortalaması
    const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
    const global = med(ratios.flat()) || 1;
    const clamp = (r) => Math.min(4, Math.max(0.8, r));
    const rOf = ratios.map((a) => clamp(med(a) || global));
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (i !== j && !measured[i][j]) T[i][j] = base.durations[i][j] * (rOf[i] + rOf[j]) / 2;
    }
    return { durations: T, distances: D, trafficRatio: global, elements, failed };
  }

  // ---- Sıralı rota (trafikli), 25 ara durak sınırı için parçalara bölünür ----
  async function route(pts, departure) {
    const legs = [], line = [];
    let t0 = departure ? departure.getTime() : Date.now();
    for (let s = 0; s < pts.length - 1; s += 26) {
      const part = pts.slice(s, s + 27);
      const body = {
        origin: { location: latLng(part[0]) },
        destination: { location: latLng(part[part.length - 1]) },
        intermediates: part.slice(1, -1).map((p) => ({ location: latLng(p) })),
        travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', languageCode: 'tr', polylineQuality: 'OVERVIEW',
      };
      if (t0 > Date.now() + 60000) body.departureTime = new Date(t0).toISOString();
      const data = await post('https://routes.googleapis.com/directions/v2:computeRoutes', body,
        'routes.legs.duration,routes.legs.distanceMeters,routes.polyline.encodedPolyline');
      track('routes');
      const r = data.routes && data.routes[0];
      if (!r) throw new Error('Google rota bulamadı');
      for (const l of r.legs) { legs.push({ duration: secs(l.duration), distance: l.distanceMeters || 0 }); t0 += secs(l.duration) * 1000; }
      line.push(...decode(r.polyline.encodedPolyline));
    }
    return {
      line, legs, approximate: false, traffic: true,
      distance: legs.reduce((a, l) => a + l.distance, 0), duration: legs.reduce((a, l) => a + l.duration, 0),
    };
  }

  function decode(str) {
    const out = [];
    let i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      for (const which of [0, 1]) {
        let b, shift = 0, result = 0;
        do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        const d = result & 1 ? ~(result >> 1) : result >> 1;
        if (which === 0) lat += d; else lng += d;
      }
      out.push([lat / 1e5, lng / 1e5]);
    }
    return out;
  }

  RB.google = { getKey, setKey, enabled, findAddress, suggest, details, trafficMatrix, route, usage };
})(window.RB);
