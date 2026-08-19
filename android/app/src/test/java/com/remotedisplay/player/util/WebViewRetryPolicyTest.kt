package com.remotedisplay.player.util

import android.webkit.WebViewClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Retrying a web frame that failed to load.
 *
 * ⚠️ THE FIELD FAILURE. A panel powers on faster than the network gives it an address. The first
 * widget load runs before DHCP has finished, fails, and the WebView paints Chrome's "webpage not
 * available" — and then keeps painting it, because nothing retried. The screen was still broken
 * long after the network came up, and the only fix on site was power-cycling the panel while
 * someone was being shown the product.
 *
 * These pin the two decisions separately: what deserves another attempt, and how long to wait.
 */
class WebViewRetryPolicyTest {

    // ===== what is worth retrying =====

    @Test fun `a network that is not up yet is retried`() {
        // The DHCP case, in the three shapes it actually arrives as.
        assertTrue("DNS not answering", WebViewRetryPolicy.shouldRetryError(WebViewClient.ERROR_HOST_LOOKUP))
        assertTrue("connect refused/failed", WebViewRetryPolicy.shouldRetryError(WebViewClient.ERROR_CONNECT))
        assertTrue("timed out", WebViewRetryPolicy.shouldRetryError(WebViewClient.ERROR_TIMEOUT))
    }

    @Test fun `an interface still coming up reports ERROR_UNKNOWN and is still retried`() {
        // WebView reports several transient DNS/interface states this way. Treating it as permanent
        // is what leaves a panel dead after a slow boot.
        assertTrue(WebViewRetryPolicy.shouldRetryError(WebViewClient.ERROR_UNKNOWN))
    }

    @Test fun `a URL that will never work is NOT retried forever`() {
        // Unsupported scheme and a bad certificate do not fix themselves; retrying burns power and
        // fills the debug log for something a human has to correct.
        assertFalse(WebViewRetryPolicy.shouldRetryError(WebViewClient.ERROR_UNSUPPORTED_SCHEME))
        assertFalse(WebViewRetryPolicy.shouldRetryError(WebViewClient.ERROR_FAILED_SSL_HANDSHAKE))
        assertFalse(WebViewRetryPolicy.shouldRetryError(WebViewClient.ERROR_FILE_NOT_FOUND))
    }

    @Test fun `a server that is up but not ready is retried, a wrong URL is not`() {
        // 5xx is the panel and its self-hosted server booting together.
        assertTrue("502 while the server starts", WebViewRetryPolicy.shouldRetryHttp(502))
        assertTrue("503", WebViewRetryPolicy.shouldRetryHttp(503))
        assertTrue("504", WebViewRetryPolicy.shouldRetryHttp(504))
        assertTrue("408 asks for a retry", WebViewRetryPolicy.shouldRetryHttp(408))
        assertTrue("429 asks for a retry", WebViewRetryPolicy.shouldRetryHttp(429))

        assertFalse("404 will not become correct", WebViewRetryPolicy.shouldRetryHttp(404))
        assertFalse("403", WebViewRetryPolicy.shouldRetryHttp(403))
        assertFalse("401", WebViewRetryPolicy.shouldRetryHttp(401))
        assertFalse("a 200 is not an error at all", WebViewRetryPolicy.shouldRetryHttp(200))
    }

    // ===== how long to wait =====

    @Test fun `the first retry is quick, because slow DHCP resolves in seconds`() {
        assertEquals(2_000L, WebViewRetryPolicy.delayMsFor(1))
        assertEquals(4_000L, WebViewRetryPolicy.delayMsFor(2))
    }

    @Test fun `it backs off but never stops trying`() {
        // A display's job is to be right whenever someone looks at it, so there is no attempt cap —
        // it settles at a steady half minute, which is what makes a two-hour outage self-heal.
        assertEquals(30_000L, WebViewRetryPolicy.delayMsFor(5))
        assertEquals(30_000L, WebViewRetryPolicy.delayMsFor(50))
        assertEquals(30_000L, WebViewRetryPolicy.delayMsFor(100_000))
    }

    @Test fun `the backoff never decreases`() {
        var prev = 0L
        for (attempt in 1..20) {
            val d = WebViewRetryPolicy.delayMsFor(attempt)
            assertTrue("attempt $attempt went backwards: $prev -> $d", d >= prev)
            prev = d
        }
    }

    @Test fun `a nonsensical attempt number still yields the first delay rather than crashing`() {
        assertEquals(2_000L, WebViewRetryPolicy.delayMsFor(0))
        assertEquals(2_000L, WebViewRetryPolicy.delayMsFor(-3))
    }

    // ===== what must never be retried =====

    @Test fun `about blank is never retried, because that is how a WebView is torn down`() {
        // MediaPlayerManager and PipOverlay both load about:blank to clear a frame. Retrying it
        // would fight the teardown and put a dead frame back on screen.
        assertFalse(WebViewRetryPolicy.isRetryableUrl("about:blank"))
        assertFalse(WebViewRetryPolicy.isRetryableUrl("ABOUT:BLANK"))
        assertFalse(WebViewRetryPolicy.isRetryableUrl(null))
        assertFalse(WebViewRetryPolicy.isRetryableUrl("   "))
    }

    @Test fun `inline documents are not retried, since there is no URL to fetch again`() {
        // The YouTube embed is loaded via loadDataWithBaseURL; there is nothing to re-request.
        assertFalse(WebViewRetryPolicy.isRetryableUrl("data:text/html,<h1>hi</h1>"))
        assertFalse(WebViewRetryPolicy.isRetryableUrl("javascript:void(0)"))
    }

    @Test fun `a real widget URL is retryable`() {
        assertTrue(WebViewRetryPolicy.isRetryableUrl("http://192.168.1.50:3001/api/widgets/render/abc"))
        assertTrue(WebViewRetryPolicy.isRetryableUrl("https://screentinker.com/api/widgets/render/abc"))
    }
}
