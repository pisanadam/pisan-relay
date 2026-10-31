# Pisan Lig köprüsü

Tarayıcıdan (telefon ve bilgisayar) Minecraft sunucularına gerçek oyuncu olarak girmeyi sağlar; varsayılan sunucu **Pisan Lig**.
Her tarayıcı oyuncusu için köprüde gerçek bir Minecraft 1.20.1 istemcisi ([mineflayer](https://github.com/PrismarineJS/mineflayer), MIT)
çalışır. Sürüm sunucudan otomatik bulunur (1.8 – en yeni). Cracked sunuculara sadece adla, online sunuculara Microsoft hesabıyla
(cihaz koduyla) girilir; Microsoft oturumu yalnızca o bağlantı boyunca tutulur. Varsayılan sunucu `pisan-sf-league.exaroton.me`. Sunucu kapalıysa bu bağlantı exaroton'un
"oyuncu girince başlat" özelliğini tetikler; sunucu açılınca oyuncu içeri girer.

Tarayıcıda Minecraft benzeri küp dünya çizilir; blokları, oyuncuları, envanteri, menüleri ve sohbeti bu istemciden alır.
Oyuncunun adı oyunda `(mobil)Ad` olur. Minecraft eklentisi bu oyuncuları anahtarla doğrular ve sıralamalara katmaz.

## Tek komutla çalıştır

```bash
curl -fsSL https://raw.githubusercontent.com/pisanadam/pisan-relay/main/start.sh | bash -s -- <ANAHTAR>
```

- `<ANAHTAR>`: eklentinin `config.yml` dosyasındaki `web-relay-key` değeri (bir kere verilince kaydedilir).
- Node.js yoksa taşınabilir Node.js 20 `~/pisan-relay/node` içine bir kere indirilir; sisteme bir şey kurulmaz.
- Arka planda çalışır; kayıtlar `~/pisan-relay/relay.log`. Durdurmak: `kill $(cat ~/pisan-relay/relay.pid)`.
- Güncellemek için aynı komutu tekrar çalıştır.

## Lisanslar

- Köprü kodu: MIT.
- `web/tex/` içindeki dokular: [Pixel Perfection CE](https://github.com/Athemis/PixelPerfectionCE), CC BY-SA 4.0
  (`web/tex/LICENSE-PixelPerfectionCE.md`), değiştirilmeden kullanıldı.
