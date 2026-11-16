// Gezgin satıcı (TSP) çözücü — gerçek yol süresi matrisi üzerinde çalışır (tek yönlü yollar için asimetrik).
// <= 13 durak: kesin en iyi çözüm (Held-Karp dinamik programlama)
// daha fazlası: En yakın komşu + 2-opt + Or-opt + Iterated Local Search (pratikte optimuma çok yakın)
window.RB = window.RB || {};

(function (RB) {
  /**
   * @param {number[][]} M  maliyet matrisi (saniye)
   * @param {object} o
   *   o.start: başlangıç düğümü indeksi veya null (serbest başlangıç)
   *   o.end:   bitiş düğümü indeksi veya null
   *   o.returnToStart: true ise başlangıca dönülür
   *   o.stops: ziyaret edilecek düğüm indeksleri
   * @returns {number[]} durakların ziyaret sırası
   */
  function solve(M, o) {
    const stops = o.stops.slice();
    const m = stops.length;
    if (m <= 1) return stops;

    const startCost = (a) => (o.start == null ? 0 : M[o.start][a]);
    const endCost = (a) => {
      if (o.returnToStart && o.start != null) return M[a][o.start];
      if (o.end != null) return M[a][o.end];
      return 0;
    };
    const cost = (t) => {
      let c = startCost(t[0]);
      for (let i = 0; i < t.length - 1; i++) c += M[t[i]][t[i + 1]];
      return c + endCost(t[t.length - 1]);
    };

    if (m <= 13) return heldKarp(M, stops, startCost, endCost);

    const deadline = Date.now() + Math.min(4000, 400 + m * 40);
    let best = localSearch(nearestNeighbor(M, stops, startCost), cost);
    let bestC = cost(best);

    // Farklı başlangıçlarla birkaç deneme
    for (let r = 0; r < 8 && Date.now() < deadline; r++) {
      const t = localSearch(randomizedNN(M, stops, startCost), cost);
      const c = cost(t);
      if (c < bestC - 1e-9) { best = t; bestC = c; }
    }
    // Iterated Local Search: "double bridge" karıştırma + yerel arama
    let cur = best.slice(), curC = bestC;
    while (Date.now() < deadline) {
      const t = localSearch(doubleBridge(cur), cost);
      const c = cost(t);
      if (c < curC - 1e-9) {
        cur = t; curC = c;
        if (c < bestC - 1e-9) { best = t.slice(); bestC = c; }
      } else if (Math.random() < 0.05) {
        cur = best.slice(); curC = bestC;
      }
    }
    return best;
  }

  function heldKarp(M, stops, startCost, endCost) {
    const m = stops.length, FULL = 1 << m;
    const dp = new Float64Array(FULL * m).fill(Infinity);
    const par = new Int8Array(FULL * m).fill(-1);
    for (let j = 0; j < m; j++) dp[(1 << j) * m + j] = startCost(stops[j]);
    for (let mask = 1; mask < FULL; mask++) {
      for (let j = 0; j < m; j++) {
        const cur = dp[mask * m + j];
        if (!(mask & (1 << j)) || cur === Infinity) continue;
        const rowJ = M[stops[j]];
        for (let k = 0; k < m; k++) {
          if (mask & (1 << k)) continue;
          const nm = mask | (1 << k);
          const v = cur + rowJ[stops[k]];
          if (v < dp[nm * m + k]) { dp[nm * m + k] = v; par[nm * m + k] = j; }
        }
      }
    }
    let bestJ = 0, bestV = Infinity;
    const last = FULL - 1;
    for (let j = 0; j < m; j++) {
      const v = dp[last * m + j] + endCost(stops[j]);
      if (v < bestV) { bestV = v; bestJ = j; }
    }
    const order = [];
    let mask = last, j = bestJ;
    while (j !== -1) {
      order.push(stops[j]);
      const pj = par[mask * m + j];
      mask &= ~(1 << j);
      j = pj;
    }
    return order.reverse();
  }

  function nearestNeighbor(M, stops, startCost) {
    const left = new Set(stops);
    let cur = null;
    const t = [];
    while (left.size) {
      let best = null, bc = Infinity;
      for (const s of left) {
        const c = cur == null ? startCost(s) : M[cur][s];
        if (c < bc) { bc = c; best = s; }
      }
      t.push(best); left.delete(best); cur = best;
    }
    return t;
  }

  function randomizedNN(M, stops, startCost) {
    const left = new Set(stops);
    let cur = null;
    const t = [];
    while (left.size) {
      const cand = [...left].map((s) => [s, cur == null ? startCost(s) + Math.random() * 1e-6 : M[cur][s]])
        .sort((a, b) => a[1] - b[1]).slice(0, 3);
      const pick = cand[Math.floor(Math.random() * cand.length)][0];
      t.push(pick); left.delete(pick); cur = pick;
    }
    return t;
  }

  function doubleBridge(t) {
    const n = t.length;
    if (n < 8) {
      const a = t.slice(), i = Math.floor(Math.random() * n), j = Math.floor(Math.random() * n);
      [a[i], a[j]] = [a[j], a[i]];
      return a;
    }
    const p = [1 + Math.floor(Math.random() * (n - 3))];
    p.push(p[0] + 1 + Math.floor(Math.random() * (n - p[0] - 2)));
    p.push(p[1] + 1 + Math.floor(Math.random() * (n - p[1] - 1)));
    return [...t.slice(0, p[0]), ...t.slice(p[2]), ...t.slice(p[1], p[2]), ...t.slice(p[0], p[1])];
  }

  function localSearch(tour, cost) {
    let t = tour.slice(), c = cost(t);
    const n = t.length;
    let improved = true;
    while (improved) {
      improved = false;
      // 2-opt: bir parçayı ters çevir
      for (let i = 0; i < n - 1 && !improved; i++) {
        for (let j = i + 1; j < n; j++) {
          const cand = t.slice(0, i).concat(t.slice(i, j + 1).reverse(), t.slice(j + 1));
          const cc = cost(cand);
          if (cc < c - 1e-9) { t = cand; c = cc; improved = true; break; }
        }
      }
      if (improved) continue;
      // Or-opt: 1-3 duraklık bir parçayı başka yere taşı (düz veya ters)
      outer: for (let len = 1; len <= 3; len++) {
        for (let i = 0; i + len <= n; i++) {
          const seg = t.slice(i, i + len);
          const rest = t.slice(0, i).concat(t.slice(i + len));
          for (let k = 0; k <= rest.length; k++) {
            if (k === i) continue;
            for (const s of len > 1 ? [seg, seg.slice().reverse()] : [seg]) {
              const cand = rest.slice(0, k).concat(s, rest.slice(k));
              const cc = cost(cand);
              if (cc < c - 1e-9) { t = cand; c = cc; improved = true; break outer; }
            }
          }
        }
      }
    }
    return t;
  }

  RB.solver = { solve };
})(window.RB);
