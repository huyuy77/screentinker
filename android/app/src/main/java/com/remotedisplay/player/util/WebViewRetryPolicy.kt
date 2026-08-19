package com.remotedisplay.player.util

import android.webkit.WebViewClient

/**
 * Should a failed web frame be loaded again, and how long should we wait first?
 *
 * ⚠️ THE FAILURE THIS EXISTS FOR. A panel powers on faster than the network gives it an address.
 * The first widget load runs before DHCP has finished, fails with a name-resolution or
 * host-unreachable error, and the WebView paints Chrome's "webpage not available" page — then keeps
 * painting it. Nothing retried, so the screen stayed broken long after the network came up, and the
 * only fix in the field was power-cycling the panel in front of whoever was being shown the product.
 *
 * Kept as a pure object with no Android dependencies beyond the error constants so the decisions can
 * be tested on a developer machine. The wiring lives in [WebViewSupport].
 *
 * TWO SEPARATE QUESTIONS, deliberately:
 *
 *  - IS IT WORTH RETRYING? Only for faults that can heal on their own. A network that is not up yet
 *    will be; a 404 will not, and hammering it just burns battery and log space for a URL that is
 *    wrong. So transient network errors and 5xx retry; 4xx does not, except 408 and 429, which are
 *    explicitly "try again".
 *  - HOW LONG DO WE WAIT? Briefly at first, because slow DHCP resolves in seconds and a screen that
 *    heals in four is a screen nobody noticed breaking. Then backing off to a steady half minute,
 *    which is the difference between recovering from a two-hour outage by itself and needing a site
 *    visit. There is no attempt cap for that reason: a display's whole job is to be showing the
 *    right thing whenever someone looks at it, and "gave up an hour ago" fails that.
 */
object WebViewRetryPolicy {

    /** Delays in milliseconds, holding at the last value for every attempt beyond the list. */
    private val BACKOFF_MS = longArrayOf(2_000, 4_000, 8_000, 15_000, 30_000)

    /**
     * Errors worth another go: the network stack could not reach the server, which is exactly what a
     * panel booting ahead of its DHCP lease looks like. Note ERROR_UNKNOWN is included — the WebView
     * reports several transient DNS and interface states that way while an interface is coming up.
     */
    private val RETRYABLE_ERRORS = setOf(
        WebViewClient.ERROR_HOST_LOOKUP,          // DNS not answering yet
        WebViewClient.ERROR_CONNECT,              // no route / refused while the server starts
        WebViewClient.ERROR_TIMEOUT,
        WebViewClient.ERROR_IO,
        WebViewClient.ERROR_PROXY_AUTHENTICATION,  // captive portal shapes
        WebViewClient.ERROR_TOO_MANY_REQUESTS,
        WebViewClient.ERROR_UNKNOWN,
    )

    /** A transport-level failure (onReceivedError). */
    fun shouldRetryError(errorCode: Int): Boolean = errorCode in RETRYABLE_ERRORS

    /**
     * An HTTP response the server did send (onReceivedHttpError).
     *
     * 5xx is a server that is up but not ready — the case where a panel and its self-hosted server
     * boot together. 408 and 429 ask for a retry in as many words. Every other 4xx is a URL that
     * will not become correct by being requested again.
     */
    fun shouldRetryHttp(status: Int): Boolean =
        status >= 500 || status == 408 || status == 429

    /**
     * How long to wait before attempt number [attempt] (1 = the first retry).
     * Non-positive attempts are treated as the first.
     */
    fun delayMsFor(attempt: Int): Long {
        if (attempt <= 1) return BACKOFF_MS[0]
        val idx = minOf(attempt - 1, BACKOFF_MS.size - 1)
        return BACKOFF_MS[idx]
    }

    /**
     * Is this a URL worth reloading at all? about:blank is how the player TEARS DOWN a WebView, so
     * retrying it would fight the teardown and resurrect a frame that was deliberately cleared.
     */
    fun isRetryableUrl(url: String?): Boolean {
        if (url.isNullOrBlank()) return false
        val u = url.trim().lowercase()
        return !u.startsWith("about:") && !u.startsWith("data:") && !u.startsWith("javascript:")
    }
}
