import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/*
 * Pisan Lig relay: runs on a host with an open port (server.pro) and joins browsers to the Minecraft plugin.
 *
 *   java -jar PisanRelay.jar <port> <key>
 *
 * Browsers open http://<host>:<port>/ and a WebSocket on /ws. The plugin dials ws://<host>:<port>/plugin?key=<key>
 * from the Minecraft server. Pages and textures are asked from the plugin and cached here; game messages are
 * passed through untouched. No libraries: plain sockets and a small WebSocket implementation.
 */
public final class PisanRelay {
    static final int MAX_BROWSERS = 60;
    static final int BROWSER_FRAME_LIMIT = 16 * 1024;
    static final int PLUGIN_FRAME_LIMIT = 32 * 1024 * 1024;

    static String key;
    static volatile Conn plugin;
    static final Map<Integer, Conn> browsers = new ConcurrentHashMap<>();
    static final AtomicInteger ids = new AtomicInteger();
    static final AtomicInteger requests = new AtomicInteger();
    static final Map<Integer, CompletableFuture<String>> pending = new ConcurrentHashMap<>();
    static final Map<String, byte[][]> cache = new ConcurrentHashMap<>();
    static final Map<String, String[]> cacheMeta = new ConcurrentHashMap<>();

    public static void main(String[] args) throws IOException {
        System.setOut(new java.io.PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out), true, StandardCharsets.UTF_8));
        // Without arguments (e.g. started as a host's "server.jar"): the port from server.properties, the key from
        // pisan-relay-key.txt next to it.
        int port = Integer.parseInt(args.length > 0 ? args[0] : env("SERVER_PORT", env("PORT", propertiesPort())));
        key = args.length > 1 ? args[1] : env("RELAY_KEY", readKeyFile());
        target = args.length > 2 ? args[2] : env("MC_SERVER", target);
        if (key.length() < 8) {
            System.err.println("Kullanım: java -jar PisanRelay.jar <port> <anahtar (en az 8 karakter)>  — ya da yanına pisan-relay-key.txt koy");
            System.exit(1);
        }
        ServerSocket server = new ServerSocket(port);
        log("Pisan Lig köprüsü " + port + " portunda açık. Eklenti bekleniyor…");
        while (true) {
            Socket s = server.accept();
            Thread t = new Thread(() -> serve(s), "conn");
            t.setDaemon(true);
            t.start();
        }
    }

    static String propertiesPort() {
        try {
            for (String line : java.nio.file.Files.readAllLines(java.nio.file.Paths.get("server.properties"))) {
                if (line.startsWith("server-port=")) {
                    return line.substring(12).trim();
                }
            }
        }
        catch (IOException ignored) {
        }
        return "25565";
    }

    static String readKeyFile() {
        try {
            return new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get("pisan-relay-key.txt")), StandardCharsets.UTF_8).trim();
        }
        catch (IOException ex) {
            return "";
        }
    }

    static String env(String name, String fallback) {
        String v = System.getenv(name);
        return v == null || v.isEmpty() ? fallback : v;
    }

    static void log(String text) {
        System.out.println("[" + java.time.LocalTime.now().withNano(0) + "] " + text);
    }

    /* One TCP connection: an HTTP request, or a WebSocket from a browser or the plugin. */
    static void serve(Socket s) {
        try {
            s.setSoTimeout(15000);
            s.setTcpNoDelay(true);
            InputStream in = s.getInputStream();
            OutputStream out = s.getOutputStream();
            String head = readHead(in);
            if (head == null) {
                s.close();
                return;
            }
            String[] lines = head.split("\r\n");
            String[] request = lines[0].split(" ");
            if (request.length < 2 || !request[0].equals("GET")) {
                http(out, 405, "text/plain", "no-store", "405".getBytes(StandardCharsets.UTF_8));
                s.close();
                return;
            }
            String path = request[1];
            Map<String, String> headers = new HashMap<>();
            for (int i = 1; i < lines.length; i++) {
                int c = lines[i].indexOf(':');
                if (c > 0) {
                    headers.put(lines[i].substring(0, c).trim().toLowerCase(), lines[i].substring(c + 1).trim());
                }
            }
            if ("websocket".equalsIgnoreCase(headers.getOrDefault("upgrade", ""))) {
                upgrade(s, in, out, path, headers);
                return;
            }
            file(out, path);
            s.close();
        }
        catch (IOException ex) {
            try {
                s.close();
            }
            catch (IOException ignored) {
            }
        }
    }

    static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int last4 = 0;
        while (buf.size() < 16384) {
            int b = in.read();
            if (b < 0) {
                return null;
            }
            buf.write(b);
            last4 = (last4 << 8) | b;
            if (last4 == 0x0D0A0D0A) {
                return buf.toString(StandardCharsets.ISO_8859_1);
            }
        }
        return null;
    }

    static void http(OutputStream out, int status, String type, String cacheControl, byte[] body) throws IOException {
        String reason = status == 200 ? "OK" : status == 404 ? "Not Found" : status == 503 ? "Service Unavailable" : "Error";
        String head = "HTTP/1.1 " + status + " " + reason + "\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length
            + "\r\nCache-Control: " + cacheControl + "\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.write(body);
        out.flush();
    }

    static final String OFFLINE = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
        + "<title>Pisan Lig</title><body style='margin:0;min-height:100vh;display:grid;place-items:center;background:#4a3420;color:#fff;"
        + "font:18px monospace;text-align:center;padding:20px;text-shadow:2px 2px 0 #3f3f3f'><div style='max-width:440px'>"
        + "<h1 style='color:#ffe36a;text-shadow:3px 3px 0 #6b4b00'>PISAN LIG</h1><p id=m>Minecraft sunucusu şu an kapalı.</p>"
        + "<button id=b style='width:100%;padding:14px;font:inherit;color:#fff;background:#7d7d7d;border:2px solid #000;"
        + "box-shadow:inset 2px 2px 0 #b8b8b8,inset -2px -2px 0 #565656;cursor:pointer'>OYNA</button>"
        + "<p id=s style='color:#ccc;font-size:14px'>Oyna'ya basınca sunucu başlatılır; açılınca oyun kendiliğinden gelir.</p></div>"
        + "<script>const b=document.getElementById('b'),m=document.getElementById('m'),s=document.getElementById('s');let t=0;"
        + "function poll(){fetch('/status',{cache:'no-store'}).then(r=>r.json()).then(o=>{if(o.online)location.reload();else{"
        + "if(o.wake)s.textContent=o.wake;setTimeout(poll,3000);}}).catch(()=>setTimeout(poll,5000));}"
        + "b.onclick=()=>{b.disabled=true;b.textContent='Sunucu başlatılıyor…';m.textContent='Exaroton bekleme alanındasın.';"
        + "fetch('/wake',{cache:'no-store'}).then(r=>r.json()).then(o=>{s.textContent=o.wake||'';}).catch(()=>{});"
        + "setInterval(()=>{t++;b.textContent='Sunucu başlatılıyor… '+t+' sn';},1000);};poll();</script>";

    /* Where the Minecraft server is (the plugin's host); a join attempt here wakes a sleeping exaroton server. */
    static String target = "pisan-sf-league.exaroton.me";
    static volatile String wakeStatus = "";
    static volatile long lastWake;

    /*
     * Knocks like a Minecraft client: handshake (1.20.1, login) and Login Start. Hosts with "start on join"
     * (exaroton) start the server and answer with a "starting" disconnect, which is passed on to the page.
     */
    static synchronized String wake() {
        long now = System.currentTimeMillis();
        if (now - lastWake < 20000) {
            return wakeStatus;
        }
        lastWake = now;
        String host = target;
        int port = 25565;
        int colon = host.lastIndexOf(':');
        if (colon > 0) {
            port = Integer.parseInt(host.substring(colon + 1));
            host = host.substring(0, colon);
        }
        try (Socket s = new Socket()) {
            s.connect(new java.net.InetSocketAddress(host, port), 8000);
            s.setSoTimeout(8000);
            OutputStream out = s.getOutputStream();
            ByteArrayOutputStream hs = new ByteArrayOutputStream();
            writeVarInt(hs, 0x00);
            writeVarInt(hs, 763);
            writeString(hs, host);
            hs.write(port >> 8);
            hs.write(port & 0xFF);
            writeVarInt(hs, 2);
            ByteArrayOutputStream login = new ByteArrayOutputStream();
            writeVarInt(login, 0x00);
            writeString(login, "PisanLig");
            login.write(0);
            frame(out, hs.toByteArray());
            frame(out, login.toByteArray());
            out.flush();
            DataInputStream in = new DataInputStream(s.getInputStream());
            int length = readVarInt(in);
            byte[] packet = new byte[Math.min(length, 65536)];
            in.readFully(packet);
            DataInputStream p = new DataInputStream(new java.io.ByteArrayInputStream(packet));
            int id = readVarInt(p);
            String reply = "";
            if (id == 0x00) {
                byte[] text = new byte[readVarInt(p)];
                p.readFully(text);
                // The kick message is a JSON text component: keep just its words.
                Matcher words = Pattern.compile("\"text\":\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(new String(text, StandardCharsets.UTF_8));
                StringBuilder b = new StringBuilder();
                while (words.find()) {
                    b.append(words.group(1));
                }
                reply = b.toString().replace("\\n", " ").replaceAll("§.", "").replaceAll("\\s+", " ").trim();
            }
            wakeStatus = reply.isEmpty() ? "Sunucuya başlatma isteği gönderildi." : reply;
            log("Sunucu uyandırma isteği gönderildi: " + wakeStatus);
        }
        catch (IOException ex) {
            wakeStatus = "Sunucuya ulaşılamadı: " + ex.getMessage();
            log(wakeStatus);
        }
        return wakeStatus;
    }

    static void frame(OutputStream out, byte[] body) throws IOException {
        ByteArrayOutputStream len = new ByteArrayOutputStream();
        writeVarInt(len, body.length);
        out.write(len.toByteArray());
        out.write(body);
    }

    static void writeVarInt(ByteArrayOutputStream out, int value) {
        while ((value & ~0x7F) != 0) {
            out.write((value & 0x7F) | 0x80);
            value >>>= 7;
        }
        out.write(value);
    }

    static void writeString(ByteArrayOutputStream out, String text) {
        byte[] b = text.getBytes(StandardCharsets.UTF_8);
        writeVarInt(out, b.length);
        out.write(b, 0, b.length);
    }

    static int readVarInt(DataInputStream in) throws IOException {
        int value = 0;
        for (int shift = 0; shift < 35; shift += 7) {
            int b = in.readUnsignedByte();
            value |= (b & 0x7F) << shift;
            if ((b & 0x80) == 0) {
                return value;
            }
        }
        throw new IOException("varint");
    }

    /* Files come from the plugin (one source of truth) and are kept here; the page is re-asked each time. */
    static void file(OutputStream out, String path) throws IOException {
        if (path.length() > 200 || !path.matches("/[A-Za-z0-9_./?=&%-]*") || path.contains("..")) {
            http(out, 404, "text/plain", "no-store", "404".getBytes(StandardCharsets.UTF_8));
            return;
        }
        if (path.equals("/status")) {
            http(out, 200, "application/json", "no-store", ("{\"online\":" + (plugin != null) + ",\"wake\":" + quote(wakeStatus) + "}").getBytes(StandardCharsets.UTF_8));
            return;
        }
        if (path.equals("/wake")) {
            String status = plugin != null ? "Sunucu açık." : wake();
            http(out, 200, "application/json", "no-store", ("{\"wake\":" + quote(status) + "}").getBytes(StandardCharsets.UTF_8));
            return;
        }
        boolean page = path.equals("/") || path.startsWith("/?") || path.startsWith("/oyna");
        byte[][] hit = cache.get(path);
        if (hit != null && !page) {
            String[] meta = cacheMeta.get(path);
            http(out, 200, meta[0], meta[1], hit[0]);
            return;
        }
        Conn p = plugin;
        if (p == null) {
            if (page) {
                http(out, 503, "text/html; charset=utf-8", "no-store", OFFLINE.getBytes(StandardCharsets.UTF_8));
            } else {
                http(out, 503, "text/plain", "no-store", "503".getBytes(StandardCharsets.UTF_8));
            }
            return;
        }
        int rid = requests.incrementAndGet();
        CompletableFuture<String> reply = new CompletableFuture<>();
        pending.put(rid, reply);
        p.sendText("{\"get\":" + quote(path) + ",\"rid\":" + rid + "}");
        String json;
        try {
            json = reply.get(10, TimeUnit.SECONDS);
        }
        catch (Exception ex) {
            pending.remove(rid);
            http(out, 504, "text/plain", "no-store", "504".getBytes(StandardCharsets.UTF_8));
            return;
        }
        if (!"200".equals(field(json, "status"))) {
            http(out, 404, "text/plain", "no-store", "404".getBytes(StandardCharsets.UTF_8));
            return;
        }
        byte[] data = Base64.getDecoder().decode(field(json, "b64"));
        String type = field(json, "type");
        String cacheControl = field(json, "cache");
        if (!page && path.startsWith("/tex/")) {
            cache.put(path, new byte[][]{data});
            cacheMeta.put(path, new String[]{type, cacheControl});
        }
        http(out, 200, type, cacheControl, data);
    }

    static void upgrade(Socket s, InputStream in, OutputStream out, String path, Map<String, String> headers) throws IOException {
        String wsKey = headers.get("sec-websocket-key");
        if (wsKey == null) {
            s.close();
            return;
        }
        boolean isPlugin = path.startsWith("/plugin");
        if (isPlugin && !key.equals(query(path, "key"))) {
            http(out, 403, "text/plain", "no-store", "403".getBytes(StandardCharsets.UTF_8));
            s.close();
            log("Yanlış anahtarla eklenti bağlantısı reddedildi: " + s.getRemoteSocketAddress());
            return;
        }
        if (!isPlugin && (!path.startsWith("/ws") || browsers.size() >= MAX_BROWSERS)) {
            s.close();
            return;
        }
        String accept;
        try {
            accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((wsKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.ISO_8859_1)));
        }
        catch (Exception ex) {
            s.close();
            return;
        }
        out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
        Conn c = new Conn(s, out);
        if (isPlugin) {
            s.setSoTimeout(60000);
            Conn old = plugin;
            plugin = c;
            cache.clear();
            log("Minecraft eklentisi bağlandı: " + s.getRemoteSocketAddress());
            if (old != null) {
                old.close();
            }
            // Browsers that were waiting on an old plugin connection start over.
            for (Conn b : browsers.values()) {
                b.close();
            }
            try {
                loop(c, in, PLUGIN_FRAME_LIMIT, PisanRelay::fromPlugin);
            }
            finally {
                if (plugin == c) {
                    plugin = null;
                    log("Minecraft eklentisi ayrıldı.");
                    for (Conn b : browsers.values()) {
                        b.close();
                    }
                }
            }
            return;
        }
        Conn p = plugin;
        if (p == null) {
            c.sendText("{\"t\":\"error\",\"text\":\"Minecraft sunucusu şu an kapalı.\"}");
            c.close();
            return;
        }
        s.setSoTimeout(120000);
        int id = ids.incrementAndGet();
        c.id = id;
        browsers.put(id, c);
        p.sendText("{\"open\":" + id + "}");
        try {
            loop(c, in, BROWSER_FRAME_LIMIT, text -> {
                Conn now = plugin;
                if (now != null) {
                    now.sendText("{\"from\":" + id + ",\"d\":" + quote(text) + "}");
                }
            });
        }
        finally {
            browsers.remove(id);
            Conn now = plugin;
            if (now != null) {
                now.sendText("{\"close\":" + id + "}");
            }
        }
    }

    static void fromPlugin(String text) {
        if (text.startsWith("{\"to\":")) {
            Conn b = browsers.get(Integer.parseInt(field(text, "to")));
            if (b != null) {
                b.sendText(field(text, "d"));
            }
        } else if (text.startsWith("{\"rid\":")) {
            CompletableFuture<String> f = pending.remove(Integer.parseInt(field(text, "rid")));
            if (f != null) {
                f.complete(text);
            }
        } else if (text.startsWith("{\"drop\":")) {
            Conn b = browsers.get(Integer.parseInt(field(text, "drop")));
            if (b != null) {
                b.close();
            }
        }
    }

    interface Handler {
        void text(String text) throws IOException;
    }

    /* Reads frames until the socket closes: text is handed on, pings answered, fragments joined. */
    static void loop(Conn c, InputStream raw, int limit, Handler handler) {
        DataInputStream in = new DataInputStream(raw);
        ByteArrayOutputStream message = new ByteArrayOutputStream();
        try {
            while (true) {
                int b0 = in.readUnsignedByte();
                int b1 = in.readUnsignedByte();
                int op = b0 & 0x0F;
                boolean fin = (b0 & 0x80) != 0;
                long len = b1 & 0x7F;
                if (len == 126) {
                    len = in.readUnsignedShort();
                } else if (len == 127) {
                    len = in.readLong();
                }
                if (len < 0 || len > limit || message.size() + len > limit) {
                    break;
                }
                byte[] mask = null;
                if ((b1 & 0x80) != 0) {
                    mask = new byte[4];
                    in.readFully(mask);
                }
                byte[] data = new byte[(int)len];
                in.readFully(data);
                if (mask != null) {
                    for (int i = 0; i < data.length; i++) {
                        data[i] ^= mask[i & 3];
                    }
                }
                if (op == 8) {
                    break;
                }
                if (op == 9) {
                    c.send(10, data);
                    continue;
                }
                if (op == 10) {
                    continue;
                }
                if (op == 1 || op == 0) {
                    message.write(data);
                    if (fin) {
                        String text = message.toString(StandardCharsets.UTF_8);
                        message.reset();
                        handler.text(text);
                    }
                }
            }
        }
        catch (SocketTimeoutException | EOFException ignored) {
        }
        catch (IOException ignored) {
        }
        c.close();
    }

    static final class Conn {
        final Socket socket;
        final OutputStream out;
        int id;

        Conn(Socket socket, OutputStream out) {
            this.socket = socket;
            this.out = out;
        }

        void sendText(String text) {
            this.send(1, text.getBytes(StandardCharsets.UTF_8));
        }

        synchronized void send(int op, byte[] data) {
            try {
                ByteArrayOutputStream frame = new ByteArrayOutputStream(data.length + 10);
                frame.write(0x80 | op);
                if (data.length < 126) {
                    frame.write(data.length);
                } else if (data.length < 65536) {
                    frame.write(126);
                    frame.write(data.length >> 8);
                    frame.write(data.length & 0xFF);
                } else {
                    frame.write(127);
                    for (int i = 7; i >= 0; i--) {
                        frame.write((int)((long)data.length >> (8 * i)) & 0xFF);
                    }
                }
                frame.write(data);
                this.out.write(frame.toByteArray());
                this.out.flush();
            }
            catch (IOException ex) {
                this.close();
            }
        }

        void close() {
            try {
                this.socket.close();
            }
            catch (IOException ignored) {
            }
        }
    }

    /* ---- tiny JSON helpers for the few flat fields this relay reads ---- */

    static String quote(String s) {
        StringBuilder b = new StringBuilder(s.length() + 16).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        b.append(String.format("\\u%04x", (int)c));
                    } else {
                        b.append(c);
                    }
            }
        }
        return b.append('"').toString();
    }

    /* The value of a top-level field: a number, or a JSON string (unescaped). */
    static String field(String json, String name) {
        String needle = "\"" + name + "\":";
        int i = json.indexOf(needle);
        if (i < 0) {
            return null;
        }
        i += needle.length();
        if (json.charAt(i) != '"') {
            int j = i;
            while (j < json.length() && "-0123456789".indexOf(json.charAt(j)) >= 0) {
                j++;
            }
            return json.substring(i, j);
        }
        StringBuilder b = new StringBuilder();
        for (int j = i + 1; j < json.length(); j++) {
            char c = json.charAt(j);
            if (c == '"') {
                return b.toString();
            }
            if (c == '\\') {
                char n = json.charAt(++j);
                switch (n) {
                    case 'n': b.append('\n'); break;
                    case 'r': b.append('\r'); break;
                    case 't': b.append('\t'); break;
                    case 'b': b.append('\b'); break;
                    case 'f': b.append('\f'); break;
                    case 'u': b.append((char)Integer.parseInt(json.substring(j + 1, j + 5), 16)); j += 4; break;
                    default: b.append(n);
                }
            } else {
                b.append(c);
            }
        }
        return null;
    }

    static String query(String path, String name) {
        Matcher m = Pattern.compile("[?&]" + name + "=([^&]*)").matcher(path);
        return m.find() ? java.net.URLDecoder.decode(m.group(1), StandardCharsets.UTF_8) : null;
    }
}
