package dev.scamshield.android;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import org.json.JSONObject;

/**
 * Hosts the on-device ScamShield UI. Text shared from another app ("Share → Check with ScamShield")
 * is handed to the page, which checks it locally — nothing is sent anywhere (no INTERNET permission).
 */
public class MainActivity extends BridgeActivity {
    private static final int MAX_SHARED_CHARS = 10_000;
    private String pendingShare;
    private boolean pageLoaded;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView webView) {
                pageLoaded = true;
                deliverShare();
            }
        });
        takeShare(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        takeShare(intent);
        deliverShare();
    }

    private void takeShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction()) || !"text/plain".equals(intent.getType())) return;
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (text == null) return;
        String s = text.toString();
        pendingShare = s.length() > MAX_SHARED_CHARS ? s.substring(0, MAX_SHARED_CHARS) : s;
    }

    private void deliverShare() {
        if (pendingShare == null || !pageLoaded) return;
        // JSONObject.quote makes the text a safe JavaScript string literal (never code).
        String js = "window.scamShieldReceiveShared && window.scamShieldReceiveShared(" + JSONObject.quote(pendingShare) + ");";
        pendingShare = null;
        bridge.getWebView().post(() -> bridge.getWebView().evaluateJavascript(js, null));
    }
}
