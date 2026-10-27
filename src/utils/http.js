import { gotScraping } from 'got-scraping';

const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 524, 999]);
const MAX_BODY_CHARS = 4_000_000;

export function proxySessionId(...parts) {
    return parts.join('_').replace(/[^\w.~]/g, '').slice(0, 50) || 'default';
}

/**
 * GET/POST with browser-like headers, proxy rotation per attempt and retries on
 * anti-bot status codes. Never throws on HTTP status; throws only when every
 * attempt failed at the network level.
 */
export async function fetchText(url, {
    proxyConfiguration,
    sessionId = 'http',
    method = 'GET',
    headers,
    form,
    body,
    cookieJar,
    timeoutMs = 20_000,
    retries = 2,
    retryOnStatus = RETRYABLE_STATUS,
} = {}) {
    let lastError;
    let lastResponse;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const proxyUrl = proxyConfiguration
            ? await proxyConfiguration.newUrl(proxySessionId(sessionId, attempt))
            : undefined;
        try {
            const res = await gotScraping({
                url,
                method,
                headers,
                form,
                body,
                cookieJar,
                proxyUrl,
                throwHttpErrors: false,
                followRedirect: true,
                maxRedirects: 8,
                retry: { limit: 0 },
                timeout: { request: timeoutMs },
                headerGeneratorOptions: {
                    browsers: [{ name: 'chrome', minVersion: 120 }],
                    devices: ['desktop'],
                    locales: ['en-US'],
                    operatingSystems: ['windows', 'macos'],
                },
            });
            const text = typeof res.body === 'string' ? res.body : String(res.body ?? '');
            lastResponse = {
                statusCode: res.statusCode,
                url: res.url,
                headers: res.headers,
                body: text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text,
                attempts: attempt + 1,
            };
            if (retryOnStatus.has(res.statusCode) && attempt < retries) continue;
            return lastResponse;
        } catch (err) {
            lastError = err;
        }
    }
    if (lastResponse) return lastResponse;
    throw lastError ?? new Error(`Request to ${url} failed`);
}

/** Runs `fn` over `items` with at most `limit` promises in flight. Preserves order. */
export async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

export function errorMessage(err) {
    if (!err) return 'Unknown error';
    // Playwright errors are multi-line with ANSI colors and a call log; keep the first line.
    const msg = String(err.message ?? err).replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0].trim();
    return msg.length > 300 ? `${msg.slice(0, 297)}...` : msg;
}
