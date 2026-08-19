package com.remotedisplay.player.util

import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Shared setup + helpers for the player's WebViews (zone widgets, fullscreen
 * widgets, YouTube). Centralizes:
 *  - JS / DOM storage / autoplay-without-gesture,
 *  - mixed-content ALLOW (self-hosted servers are often http on the LAN; without
 *    this an https page embedding http - or vice versa - is silently blocked into
 *    a black broken-frame),
 *  - error/console logging piped to DebugLog so a failing web frame shows the
 *    real reason in the live debug panel instead of just a black broken-page view,
 *  - a YouTube embed that loads with a valid youtube.com origin (fixes Error 153).
 */
object WebViewSupport {

    const val YT_BASE = "https://www.youtube.com"
    // Base URL the embed page is loaded under (its referrer to YouTube). It must be
    // a normal embedding site, NOT youtube.com itself — a page claiming to be
    // youtube.com embedding a youtube.com iframe is rejected as an invalid embed
    // context ("This video is unavailable / Error 152"). A real third-party domain
    // is what legitimate embeds use.
    const val EMBED_BASE = "https://screentinker.com"

    fun configure(webView: WebView, tag: String) {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        webView.setBackgroundColor(android.graphics.Color.TRANSPARENT)
        // Interactive widgets (e.g. directory-search) need the WebView to take
        // touch focus so the search field accepts a tap/cursor inside the kiosk
        // lock-task WebView. Harmless for passive widgets (board/YouTube): they
        // have no focusable inputs, so nothing steals focus or pops the IME. The
        // widget's own on-screen keyboard drives the filter even when the system
        // IME is suppressed (it mutates the input value directly, no focus needed).
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        /*
         * ⚠️ A FAILED LOAD MUST RETRY ITSELF.
         *
         * A panel powers on faster than the network hands it an address, so the first load runs
         * before DHCP finishes, fails, and the WebView paints Chrome's "webpage not available".
         * That page then stays up: nothing here used to do anything but log it. The screen was
         * still broken minutes later with the network long since up, and the only field fix was
         * power-cycling the panel — in front of whoever was being shown the product.
         *
         * State per WebView, held in the closure: how many attempts, and the pending Runnable so a
         * teardown can cancel it. WebViewRetryPolicy decides what is worth retrying and how long to
         * wait; see the reasoning there.
         */
        var retryAttempt = 0
        var pendingRetry: Runnable? = null

        fun cancelRetry(view: WebView?) {
            pendingRetry?.let { view?.removeCallbacks(it) }
            pendingRetry = null
        }

        fun scheduleRetry(view: WebView?, url: String?, why: String) {
            if (view == null) return
            if (!WebViewRetryPolicy.isRetryableUrl(url)) return
            retryAttempt += 1
            val delay = WebViewRetryPolicy.delayMsFor(retryAttempt)
            DebugLog.w(tag, "load failed ($why) — retry #$retryAttempt in ${delay}ms url=$url")
            cancelRetry(view)
            val r = Runnable {
                pendingRetry = null
                // Re-request the URL rather than reload(): after an error the WebView's current
                // page is Chrome's error document, and reload() on some builds re-renders that
                // instead of fetching again.
                try { view.loadUrl(url!!) } catch (t: Throwable) {
                    DebugLog.e(tag, "retry load threw: ${t.message}")
                }
            }
            pendingRetry = r
            view.postDelayed(r, delay)
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                /*
                 * A new load supersedes any retry we were holding. Without this, the player moving
                 * this WebView on to the next item — or tearing it down with about:blank — would
                 * still be chased by a pending reload of the PREVIOUS url, which lands seconds later
                 * and puts a frame back on screen that nothing is expecting.
                 */
                cancelRetry(view)
                super.onPageStarted(view, url, favicon)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                // A page that loaded is the end of the backoff: the next fault starts from 2s again,
                // so a screen that drops out for a moment recovers quickly rather than inheriting a
                // 30s wait from an outage hours ago.
                if (WebViewRetryPolicy.isRetryableUrl(url) && retryAttempt > 0) {
                    DebugLog.i(tag, "load recovered after $retryAttempt retry(s) url=$url")
                }
                if (WebViewRetryPolicy.isRetryableUrl(url)) retryAttempt = 0
                super.onPageFinished(view, url)
            }

            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                if (request?.isForMainFrame != true) return
                val code = error?.errorCode ?: WebViewClient.ERROR_UNKNOWN
                DebugLog.e(tag, "WebView load error $code ${error?.description} url=${request.url}")
                if (WebViewRetryPolicy.shouldRetryError(code)) {
                    scheduleRetry(view, request.url?.toString(), "error $code")
                }
            }

            override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest?, errorResponse: WebResourceResponse?) {
                if (request?.isForMainFrame != true) return
                val status = errorResponse?.statusCode ?: 0
                DebugLog.e(tag, "WebView HTTP $status url=${request.url}")
                if (WebViewRetryPolicy.shouldRetryHttp(status)) {
                    scheduleRetry(view, request.url?.toString(), "HTTP $status")
                }
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage?): Boolean {
                if (msg?.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    DebugLog.w(tag, "JS error: ${msg.message()} @${msg.sourceId()}:${msg.lineNumber()}")
                }
                return super.onConsoleMessage(msg)
            }
        }
    }

    fun extractYoutubeId(url: String): String? {
        val patterns = listOf(
            Regex("""embed/([A-Za-z0-9_-]{6,})"""),
            Regex("""[?&]v=([A-Za-z0-9_-]{6,})"""),
            Regex("""youtu\.be/([A-Za-z0-9_-]{6,})""")
        )
        for (p in patterns) p.find(url)?.let { return it.groupValues[1] }
        return null
    }

    /**
     * HTML wrapper for a YouTube embed. Loaded via loadDataWithBaseURL(YT_BASE, ...)
     * so the iframe has a valid youtube.com origin/referer (a bare loadUrl of the
     * embed gives Error 153 "player misconfigured"). Returns null if no video id.
     *
     * #129: the initial mute now comes from the per-item [muted] flag (was hardcoded
     * mute=1, which made YouTube un-unmuteable). The WebView sets
     * mediaPlaybackRequiresUserGesture=false, so mute=0 still autoplays WITH audio.
     * enablejsapi=1 lets the live device:mute-changed toggle drive the player via the
     * IFrame API postMessage bridge (MediaPlayerManager.setYoutubeMuted) without a
     * flicker-y reload.
     */
    fun youtubeEmbedHtml(url: String, muted: Boolean = true): String? {
        val id = extractYoutubeId(url) ?: return null
        val mute = if (muted) 1 else 0
        // Vertical (Shorts) content is tagged st_aspect=vertical at ingest.
        val vertical = url.contains("st_aspect=vertical")
        val src = "$YT_BASE/embed/$id?autoplay=1&mute=$mute&controls=0&rel=0&modestbranding=1&loop=1&playlist=$id&playsinline=1&enablejsapi=1"
        // Vertical: center a 9:16 iframe so it fills a portrait panel and pillarboxes
        // cleanly on landscape, instead of a 100%x100% landscape frame.
        val css = if (vertical)
            "html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden;display:flex;align-items:center;justify-content:center}" +
            "iframe{display:block;height:100%;aspect-ratio:9/16;max-width:100%;border:0}"
        else
            "html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}"
        return "<!DOCTYPE html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
            "<style>$css</style>" +
            "</head><body><iframe src=\"$src\" allow=\"autoplay; encrypted-media\" allowfullscreen></iframe></body></html>"
    }
}
