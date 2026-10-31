# Pisan Lig köprüsü

Pisan SF League Minecraft sunucusundaki tarayıcı oyununu (telefon ve bilgisayar) internete açan küçük köprü.
Minecraft eklentisi bu köprüye kendisi bağlanır; oyuncular `http://<adres>:<port>/` adresinden girer.

## Tek komutla çalıştır

```bash
curl -fsSL https://raw.githubusercontent.com/pisanadam/pisan-relay/main/start.sh | bash -s -- <ANAHTAR>
```

- `<ANAHTAR>`: eklentinin `config.yml` dosyasındaki `web-relay-key` değeri.
- Port verilmezse `server.properties` içindeki `server-port` kullanılır. Farklı port için: `… | bash -s -- <ANAHTAR> 25570`
- Java yoksa taşınabilir Java 17 (Eclipse Temurin) `~/pisan-relay/jre` içine bir kere indirilir; sisteme bir şey kurulmaz.
- Köprü arka planda çalışır, shell kapansa da durmaz. Kayıtlar: `~/pisan-relay/relay.log`
- Durdurmak: `kill $(cat ~/pisan-relay/relay.pid)` • Güncellemek/yeniden başlatmak: aynı komutu tekrar çalıştır (anahtar kayıtlıysa anahtarsız da olur).
- Kütüphane yok; tek dosya: `PisanRelay.java`.

## Eklenti ayarı (Minecraft sunucusu)

```yaml
web-relay-url: "ws://<alan-adı-veya-ip>:<port>/plugin"
web-relay-key: "<ANAHTAR>"
```

## Derleme

```bash
javac --release 11 -d out PisanRelay.java && printf "Main-Class: PisanRelay\n" > m.txt && jar cfm PisanRelay.jar m.txt -C out .
```
