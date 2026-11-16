// Ekran görüntüsünden metin okuma (Tesseract.js, Türkçe). Tamamen tarayıcıda çalışır, görsel hiçbir yere gönderilmez.
window.RB = window.RB || {};

(function (RB) {
  let workerPromise = null;

  function getWorker(onProgress) {
    if (!workerPromise) {
      workerPromise = Tesseract.createWorker('tur', 1, {
        logger: (m) => onProgress && onProgress(m),
      });
    }
    return workerPromise;
  }

  // Küçük görselleri büyütüp gri tonlamaya çevirir: OCR isabetini belirgin artırır
  async function preprocess(file) {
    const bmp = await createImageBitmap(file);
    const scale = bmp.width < 1400 ? Math.min(3, 1400 / bmp.width) : 1;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = g;
      sum += g;
    }
    // Koyu tema ekran görüntüsüyse renkleri ters çevir (Tesseract açık zemini sever)
    if (sum / (d.length / 4) < 110) {
      for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 255 - d[i];
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // OCR çıktısını temizler: anlamsız kısa satırları atar, paragraf boşluklarını korur
  function cleanText(text) {
    return text
      .split('\n')
      .map((l) => l.replace(/[^\p{L}\p{N}\s.,:;\/\-'()#@?=&]/gu, ' ').replace(/\s+/g, ' ').trim())
      .map((l) => (l.replace(/[^\p{L}\p{N}]/gu, '').length < 3 ? '' : l))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  async function readImages(files, onStatus) {
    const out = [];
    for (let i = 0; i < files.length; i++) {
      const label = files.length > 1 ? `Görsel ${i + 1}/${files.length}: ` : '';
      onStatus(`${label}hazırlanıyor…`);
      const worker = await getWorker((m) => {
        if (m.status === 'recognizing text') onStatus(`${label}okunuyor %${Math.round(m.progress * 100)}`);
        else if (m.status && m.status.includes('loading')) onStatus(`Türkçe dil paketi yükleniyor (ilk seferde ~10 sn)…`);
      });
      const canvas = await preprocess(files[i]);
      const { data } = await worker.recognize(canvas);
      out.push(cleanText(data.text));
    }
    return out.filter(Boolean).join('\n\n');
  }

  RB.ocr = { readImages };
})(window.RB);
