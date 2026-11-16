// Gerçek yol mesafesi/süresi (OSRM). Sunucu yanıt vermezse kuş uçuşu tahmine düşer.
window.RB = window.RB || {};

(function (RB) {
  const SERVERS = {
    driving: [
      'https://routing.openstreetmap.de/routed-car/{svc}/v1/driving/',
      'https://router.project-osrm.org/{svc}/v1/driving/',
    ],
    foot: ['https://routing.openstreetmap.de/routed-foot/{svc}/v1/driving/'],
  };

  const coordStr = (pts) => pts.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');

  async function osrm(svc, profile, pts, query) {
    let lastErr;
    for (const base of SERVERS[profile] || SERVERS.driving) {
      const url = base.replace('{svc}', svc) + coordStr(pts) + '?' + new URLSearchParams(query);
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20000);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        const data = await res.json();
        if (data.code === 'Ok') return data;
        lastErr = new Error(data.message || data.code);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('OSRM yanıt vermedi');
  }

  function fallbackMatrix(pts, profile) {
    const speed = profile === 'foot' ? 4.5 : 28; // km/s ortalama (şehir içi)
    const n = pts.length;
    const durations = [], distances = [];
    for (let i = 0; i < n; i++) {
      durations.push([]); distances.push([]);
      for (let j = 0; j < n; j++) {
        const km = RB.geo.haversineKm(pts[i], pts[j]) * 1.35;
        distances[i].push(km * 1000);
        durations[i].push((km / speed) * 3600);
      }
    }
    return { durations, distances, approximate: true };
  }

  async function matrix(pts, profile) {
    try {
      const d = await osrm('table', profile, pts, { annotations: 'duration,distance' });
      // Ulaşılamayan çiftler null gelir: kuş uçuşu tahminle doldur
      const fb = fallbackMatrix(pts, profile);
      const fill = (A, B) => A.map((row, i) => row.map((v, j) => (v == null ? B[i][j] * 3 : v)));
      return { durations: fill(d.durations, fb.durations), distances: fill(d.distances, fb.distances), approximate: false };
    } catch (e) {
      console.warn('OSRM table hatası, kuş uçuşu tahmin kullanılıyor', e);
      return fallbackMatrix(pts, profile);
    }
  }

  // Sıralı noktalar için çizilecek yol geometrisi + bacak (leg) süreleri
  async function route(pts, profile) {
    try {
      const d = await osrm('route', profile, pts, { overview: 'full', geometries: 'geojson', steps: 'false' });
      const r = d.routes[0];
      return {
        line: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
        legs: r.legs.map((l) => ({ distance: l.distance, duration: l.duration })),
        distance: r.distance, duration: r.duration, approximate: false,
      };
    } catch (e) {
      console.warn('OSRM route hatası', e);
      const fb = fallbackMatrix(pts, profile);
      const legs = [];
      for (let i = 0; i < pts.length - 1; i++) legs.push({ distance: fb.distances[i][i + 1], duration: fb.durations[i][i + 1] });
      return {
        line: pts.map((p) => [p.lat, p.lon]), legs,
        distance: legs.reduce((a, l) => a + l.distance, 0), duration: legs.reduce((a, l) => a + l.duration, 0),
        approximate: true,
      };
    }
  }

  RB.routing = { matrix, route };
})(window.RB);
