// Adres metnini ayrıştırma ve Türkçe adres normalizasyonu
window.RB = window.RB || {};

(function (RB) {
  const lower = (s) => s.toLocaleLowerCase('tr');

  // "Mah." -> "Mahallesi" gibi kısaltmaları açar
  // JS'deki \b Türkçe harfleri (ı, ğ, ş...) tanımaz; Unicode duyarlı sınırlar kullanıyoruz
  const W = (alts) => new RegExp(`(?<![\\p{L}\\d])(?:${alts})(?![\\p{L}\\d])\\.?`, 'giu');
  const ABBR = [
    [W('mah|mh|mahalle'), 'Mahallesi'],
    [W('cad|cd|cadde'), 'Caddesi'],
    [W('sok|sk|sokağı|sokagi|sokak'), 'Sokak'],
    [W('bulv|blv|bul|bulvar'), 'Bulvarı'],
    [W('meyd|mey'), 'Meydanı'],
  ];

  const ADDRESS_HINT = /((?<![\p{L}])(mah|mahalle|mahallesi|mh|cad|caddesi|cd|sok|sokak|sokağı|sk|bulv|blv|bulvarı)(?![\p{L}])|(?<![\p{L}])no\s*[:.]?\s*\d|\d{1,2}\.\d{3,}\s*,\s*\d{1,3}\.\d{3,}|maps\.|goo\.gl)/iu;

  // Telefon, sıra numarası, madde işareti gibi gürültüyü temizler
  function stripNoise(s) {
    return s
      .replace(/(\+?90[\s-]?)?0?5\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g, ' ') // cep tel
      .replace(/^\s*(\d{1,3}[.)\-]|[-•*·▪●○])\s+/u, '') // "1. ", "- ", "• "
      .replace(/[|¦]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function looksLikeAddress(line) {
    return ADDRESS_HINT.test(line);
  }

  // Metni adres listesine çevirir.
  // - Boş satırlarla ayrılmış bloklar varsa her blok bir adres sayılır
  //   (blok içindeki satırların çoğu tek başına adres gibiyse satır satır bölünür)
  // - Aksi halde her satır bir adres
  function splitAddresses(text) {
    const norm = (text || '').replace(/\r\n?/g, '\n');
    const blocks = norm.split(/\n\s*\n/).map((b) => b.split('\n').map(stripNoise).filter((l) => l.length >= 3));
    const out = [];
    for (const lines of blocks) {
      if (!lines.length) continue;
      if (lines.length === 1) { out.push(lines[0]); continue; }
      const addrLike = lines.filter(looksLikeAddress).length;
      if (addrLike >= 2 && addrLike / lines.length >= 0.5) {
        out.push(...lines);
      } else {
        out.push(lines.join(', '));
      }
    }
    return out.filter((a) => a.replace(/[^\p{L}\d]/gu, '').length >= 4);
  }

  // Listenin çoğu belirgin adresse (Mah./Cad./No: içeren), adres gibi görünmeyen satırları
  // (sipariş no, müşteri adı, saat vb. — genelde ekran görüntüsünden gelir) ayıkla.
  function pickAddresses(text) {
    const all = splitAddresses(text);
    const like = all.filter(looksLikeAddress);
    if (like.length >= 2 && like.length >= all.length * 0.4 && like.length < all.length) {
      return { addresses: like, ignored: all.filter((a) => !looksLikeAddress(a)) };
    }
    return { addresses: all, ignored: [] };
  }

  // Doğrudan koordinat veya harita linki içeriyorsa koordinatı döndürür
  function parseCoords(s) {
    let m =
      s.match(/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/) ||
      s.match(/!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/) ||
      s.match(/[?&](?:q|ll|query|destination|daddr)=(-?\d{1,2}\.\d+)(?:,|%2C)\s*(-?\d{1,3}\.\d+)/i) ||
      s.match(/(?:^|[^\d.])(-?\d{1,2}\.\d{3,})\s*[,;]\s*(-?\d{1,3}\.\d{3,})(?![\d.])/);
    if (!m) return null;
    const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  function expandAbbr(s) {
    let r = ' ' + s + ' ';
    r = r.replace(/([\p{L}\d])\/([\p{L}])/gu, '$1, $2'); // "Kadıköy/İstanbul"
    for (const [re, rep] of ABBR) r = r.replace(re, rep);
    return r.replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
  }

  // Adresi parçalarına ayırır: mahalle, cadde/sokak, kapı no, geri kalan (ilçe/il)
  function parseAddress(raw) {
    const s = expandAbbr(stripNoise(raw));
    const numM = s.match(/(?<![\p{L}])No\s*[:.]?\s*(\d+(?:\s?[A-Za-z](?![\p{L}:.\d]))?)/iu) || s.match(/(?<![\p{L}])Numara\s*[:.]?\s*(\d+)/iu);
    const number = numM ? numM[1].replace(/\s/g, '') : '';

    // Daire/kat/blok/apartman gibi kapı içi detayları at
    let core = s
      .replace(/(?<![\p{L}])No\s*[:.]?\s*\d+(?:\s?[A-Za-z](?![\p{L}:.\d]))?(\s*\/\s*\d+)?/giu, ' ')
      .replace(/(?<![\p{L}])(D|Daire|Kat|K|İç\s*Kapı|Ic\s*Kapi)\s*[:.]?\s*\d+[A-Za-z]?(?![\p{L}])/giu, ' ')
      .replace(/(?<![\p{L}\d])[\p{L}\d.]+\s+(Apartmanı|Apartman|Apt\.?|Sitesi|Blok|Blk\.?|Plaza|Rezidans)(?![\p{L}])/giu, ' ')
      .replace(/(?<![\p{L}])[A-Z]\s*Blok(?![\p{L}])/gu, ' ')
      .replace(/(?<!\d)\d{5}(?!\d)/g, ' ') // posta kodu
      .replace(/\s*,\s*(,\s*)+/g, ', ')
      .replace(/\s+/g, ' ')
      .replace(/^[,\s]+|[,\s]+$/g, '');

    const mahM = core.match(/([\p{L}\d.'\- ]+?)\s+Mahallesi/u);
    const mahalle = mahM ? mahM[1].split(',').pop().trim() + ' Mahallesi' : '';
    // İzmir'de numaralı sokaklar yaygın: "1203/1 Sokak", "372. Sokak"
    const streetM = core.match(/([\p{L}\d.'\/\- ]+?)\s+(Caddesi|Sokak|Bulvarı|Yolu|Meydanı|Küme Evleri)/u);
    let street = '';
    if (streetM) {
      let name = streetM[1].split(',').pop().trim();
      name = name.replace(/^.*Mahallesi\s*/u, '').trim();
      if (name) street = name + ' ' + streetM[2];
    }
    // Mahalle/sokaktan SONRA kalan kısım genellikle ilçe/il bilgisidir (öncesi çoğu zaman isim vb.)
    let rest = core;
    const cut = Math.max(
      mahalle ? core.indexOf(mahalle) + mahalle.length : -1,
      street ? core.indexOf(street) + street.length : -1,
    );
    if (cut > 0) rest = core.slice(cut);
    rest = rest.split(',').map((x) => x.replace(/^[\s:.\-]+|[\s:.\-]+$/g, '').trim())
      .filter((x) => x && /\p{L}/u.test(x)).join(', ');

    return { raw, display: s, core, mahalle, street, number, rest };
  }

  function containsLoose(hay, needle) {
    const h = lower(hay);
    return lower(needle).split(/[,\s]+/).filter((w) => w.length > 2).every((w) => h.includes(w));
  }

  function withRegion(q, region) {
    if (!region) return q;
    // Bölgenin sadece adreste geçmeyen parçalarını ekle ("Kadıköy" varsa sadece "İstanbul")
    const missing = region.split(',').map((x) => x.trim()).filter((x) => x && !containsLoose(q, x));
    return missing.length ? `${q}, ${missing.join(', ')}` : q;
  }

  // En spesifikten en genele doğru arama sorguları üretir
  function queryVariants(p, region) {
    const v = [];
    const tail = p.rest ? `, ${p.rest}` : '';
    if (p.street && p.number) v.push(`${p.street} ${p.number}${tail}`);
    if (p.street && p.mahalle) v.push(`${p.street}, ${p.mahalle}${tail}`);
    if (p.street) v.push(`${p.street}${tail}`);
    if (!p.street) v.push(p.core);
    if (p.mahalle) v.push(`${p.mahalle}${tail}`);
    if (p.street && p.number) v.push(`${p.street} ${p.number}`); // "rest" hatalı olabilir
    if (p.street) v.push(p.street);
    if (p.mahalle) v.push(p.mahalle);
    const seen = new Set();
    return v
      .map((q) => withRegion(q.replace(/\s+/g, ' ').trim(), region))
      .filter((q) => q.length > 3 && !seen.has(lower(q)) && seen.add(lower(q)));
  }

  function cacheKey(s) {
    return lower(s).replace(/[^\p{L}\d]+/gu, ' ').trim();
  }

  RB.parse = { splitAddresses, pickAddresses, parseCoords, parseAddress, queryVariants, cacheKey, lower, looksLikeAddress };
})(window.RB);
