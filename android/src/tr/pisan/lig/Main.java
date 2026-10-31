package tr.pisan.lig;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/* Pisan Lig as an app: the browser game from the relay, full screen, sideways, screen kept on. */
public class Main extends Activity {
    // The relay's addresses: the name first, the bare IP if the name does not resolve.
    private static final String[] ADDRESSES = { "http://pisankus.serv.gs:25565/", "http://43.226.0.124:25565/" };
    private WebView web;
    private int address;
    private ValueCallback<Uri[]> picking;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_FULLSCREEN);
        if (Build.VERSION.SDK_INT >= 28) w.getAttributes().layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setUserAgentString(s.getUserAgentString() + " PisanLigApp/1.0");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String here = Uri.parse(ADDRESSES[address]).getHost();
                if (here != null && here.equals(u.getHost())) return false;
                // Other links (Microsoft sign-in, licences) open in the phone's browser.
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (!req.isForMainFrame()) return;
                if (address + 1 < ADDRESSES.length) { address++; view.loadUrl(ADDRESSES[address]); return; }
                view.loadData(OFFLINE, "text/html; charset=utf-8", "utf-8");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                // "Doku paketi yükle": pick a .zip or .jar from the phone.
                if (picking != null) picking.onReceiveValue(null);
                picking = callback;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try { startActivityForResult(Intent.createChooser(i, "Doku paketi seç"), 7); }
                catch (Exception e) { picking = null; return false; }
                return true;
            }
        });
        setContentView(web);
        immersive();
        if (saved != null) web.restoreState(saved); else web.loadUrl(ADDRESSES[0]);
    }

    private static final String OFFLINE = "<html><body style='background:#222;color:#eee;font-family:sans-serif;text-align:center;padding-top:30vh'>"
        + "<h2>Pisan Lig köprüsüne ulaşılamadı</h2><p>İnternetini kontrol et; köprü kapalıysa biraz sonra dene.</p>"
        + "<button style='font-size:20px;padding:10px 24px' onclick='location.href=\"" + "http://pisankus.serv.gs:25565/" + "\"'>Tekrar dene</button></body></html>";

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request == 7 && picking != null) {
            Uri u = result == RESULT_OK && data != null ? data.getData() : null;
            picking.onReceiveValue(u == null ? null : new Uri[] { u });
            picking = null;
        }
    }

    private void immersive() {
        web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override
    public void onWindowFocusChanged(boolean focus) {
        super.onWindowFocusChanged(focus);
        if (focus) immersive();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        // Back does not throw you out of a match by accident.
        new AlertDialog.Builder(this).setMessage("Oyundan çıkılsın mı?")
            .setPositiveButton("Çık", new android.content.DialogInterface.OnClickListener() { public void onClick(android.content.DialogInterface d, int i) { finish(); } })
            .setNegativeButton("Kal", null).show();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
