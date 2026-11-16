# Rota Belirleyici (İzmir)

Günlük teslimat/ziyaret adreslerini alıp **trafiği hesaba katarak en az km'lik sırayı** durak durak çıkaran,
kurulum gerektirmeyen web uygulaması. Sadece **İzmir ili** içinde çalışır; il dışındaki her sonuç reddedilir.

## Çalıştırma

```bash
python -m http.server 5173
```

Tarayıcıda `http://localhost:5173`. (Telefonda konum için sitenin https ile yayınlanması gerekir.)

## Adres girişi

- **Yaz ve seç:** Üstteki kutuya birkaç harf yaz ("kıbrıs şehitleri 12"), açılan öneriden seç → kesin konum.
- **Ctrl+V:** Kopyaladığın adres listesini ya da ekran görüntüsünü sayfaya yapıştır. Görseller tarayıcıda okunur.
  Sipariş no, isim, telefon gibi satırlar otomatik ayıklanır.
- **Kontrol listesi:** Her adresin durumu görünür. ✓ tam, 🟠 yaklaşık, ✗ bulunamadı.
  ✏️ ile düzelt (öneri çıkar), 📍 ile haritada işaretle. Düzeltmeler hatırlanır.

Güvenlik kontrolleri: Bulunan sonucun sokak adı ve ilçesi adresle tutmalıdır. Numaralı sokakta numara birebir aynı
olmalıdır ("372" ≠ "372/5"). Diğer adreslerden çok uzak düşen sonuç "şüpheli" işaretlenir.

## Kullanım (telefon)

1. **1 · Adresler:** Kutuya adres yaz ve öneriden seç, kopyaladığın listeyi kutuya yapıştır (her satır ayrı
   eklenir) ya da 📷 ile ekran görüntüsü seç. Turuncu nokta = sokak bulundu, kırmızı = bulunamadı (✏️ / 📍 ile düzelt).
2. **🚀 Rotayı oluştur:** Başlangıç boşsa telefonun konumu kullanılır.
3. **2 · Rota → Sıradaki durak kartı:** "▶ Yol tarifi" ile o durağa navigasyonu aç, varınca "✓ Teslim edildi"
   ya da "✗ Edilemedi"ye bas; kart otomatik bir sonraki durağa geçer ("↶ Geri al" ile düzeltilir).
   Duraklara not ve kapıda tahsil edilecek tutar eklenebilir (durağa dokun ya da "📝 Not / tahsilat ekle").
   İlerleme çubuğu teslim/edilemedi sayısını ve tahsilatı gösterir. Bütün rotayı tek seferde açmak için
   "🗺️ Tüm rotayı tek seferde aç" bölümü var.

Günün rotası ve durumlar cihazda saklanır: telefon sekmeyi yenilese de kaldığın yerden devam edilir.

Ayarlar (başlangıç, bitiş, öncelik, navigasyon uygulaması, çıkış saati) katlanır "⚙️ Rota ayarları" bölümünde.

**Yandex seçeneği:** Adresler Yandex'e "Türkiye, İzmir, ilçe, mahalle, sokak, no" formatında gönderilir
(serbest yazımda başka şehirle karıştırabiliyordu). Testlerde Yandex bazı adreslerde kapı yerine en yakın binayı
ya da sadece caddeyi buldu; kapı numarası için Google Maps daha isabetli.

## Ücretsiz kullanım: kapı numarası Google Maps uygulamasında

API anahtarı olmadan sıralama ücretsiz harita verisiyle (sokak seviyesi) yapılır. Google Maps linklerinde ise
duraklar **adres metni** olarak gönderilir; kapı numarasını telefondaki Google Maps kendisi bulur. Canlı trafiğe göre
yol seçimini de navigasyon sırasında Google Maps yapar. Kesin konumu bilinen duraklar (öneriden seçilen, haritada
işaretlenen) koordinatla gönderilir. Bir link en fazla 10 durak taşır; uzun rotalar parçalara bölünür.

## Trafik ve optimizasyon

- **Öncelik:** En az km (varsayılan) / Dengeli / En hızlı.
  Maliyet = trafikli süre + ağırlık × km. "En az km" modunda daha uzun yol, ancak km başına 6+ dk trafik
  gecikmesinden kaçınıyorsa seçilir.
- **Trafik (Google API anahtarı ile):** Her durağın en yakın birkaç komşusu için canlı/tahmini trafik süresi
  alınır, kalan çiftler ölçülen trafik oranıyla tahmin edilir (30 durakta ~150 öğe). Sıra çözülür, son rota tamamen
  trafikli hesaplanır, gerçek bacak süreleriyle bir kez daha iyileştirilir.
- **Anahtarsız:** OSRM ile trafiksiz yol mesafesi/süresi. Ücretsiz adres kaynakları (OpenStreetMap) İzmir'de
  kapı numarası bilmediği için çoğu adres sokak seviyesinde (🟠) bulunur; uzun caddelerde bu sapma büyük olabilir.
- 13 durağa kadar kesin en iyi çözüm, üstünde 2-opt + Or-opt + Iterated Local Search.

## Google API anahtarı

1. console.cloud.google.com → proje oluştur → faturalandırmayı aç.
2. **Routes API**, **Places API (New)**, **Geocoding API**'yi etkinleştir.
3. API anahtarı oluştur, HTTP referrer ile bu siteye ve bu 3 API'ye kısıtla.
4. Bütçe uyarısı kur. Uygulamadaki "Trafik verisi (Google)" bölümüne yapıştır.
   Aylık kullanım uygulamada sayılır.

## Dosyalar

| Dosya | İş |
|---|---|
| `js/parse.js` | Metni adreslere bölme, Türkçe adres normalizasyonu |
| `js/geocode.js` | Adres → koordinat, İzmir sınırı, doğrulama kuralları, önbellek |
| `js/google.js` | Google adres, öneri, trafikli matris ve rota |
| `js/autocomplete.js` | Yazarken öneri kutusu |
| `js/routing.js` | OSRM süre/mesafe matrisi ve rota çizgisi |
| `js/solver.js` | TSP çözücü |
| `js/ocr.js` | Ekran görüntüsünden metin okuma |
| `js/app.js` | Akış, liste, harita |
