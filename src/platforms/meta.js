// Meta Ad Library checks with a real browser (Playwright via Crawlee).
//
// Flow per business (labels):
//   FB_PAGE        facebook.com/<vanity>  -> page ID          -> ADLIB_PAGE
//   ADLIB_KEYWORD  keyword search          -> best advertiser -> ADLIB_PAGE
//   ADLIB_PAGE     ads of one page (view_all_page_id) -> final result
//
// Data is read from the JSON the page itself loads (embedded + GraphQL), not
// from CSS selectors, so cosmetic redesigns of the Ad Library do not break it.

import { PlaywrightCrawler, playwrightUtils } from 'crawlee';

import { errorMessage } from '../utils/http.js';
import {
    buildAdLibraryUrl, collectFromDocuments, extractPageIdFromHtml, newCollectState, parseJsonDocuments,
    parseMetaAd, parseResultsText, pickAdvertiser, summarizeMetaAds,
} from './meta-parse.js';

export function emptyMetaResult() {
    return {
        checked: false,
        isRunningAds: false,
        matchMethod: null,
        matchConfidence: null,
        pageId: null,
        pageName: null,
        pageUrl: null,
        adLibraryUrl: null,
        activeAdsCount: 0,
        countIsLowerBound: false,
        adsAnalyzed: 0,
        adsStartedInWindow: 0,
        oldestActiveAdStartDate: null,
        newestActiveAdStartDate: null,
        longestRunningAdDays: null,
        publisherPlatforms: [],
        displayFormats: {},
        topCallsToAction: [],
        landingDomains: [],
        sampleAds: [],
        error: null,
    };
}

const BLOCK_PATTERNS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.mp4', '.webm', '.woff', '.woff2', '.ttf', '.otf', '.css'];
const WAIT_MAX_MS = 15_000;

/**
 * Creates the crawler. `getContext(bizId)` returns { biz, name, domains,
 * windowDays, maxSampleAds, keywordFallback } or null for stale requests.
 * `onDone(bizId, metaResult)` receives the final result for each business.
 */
export function createMetaCrawler({ proxyConfiguration, maxConcurrency, country, attempt, getContext, onDone, log, launchOptions = {} }) {
    const buckets = new WeakMap();

    const finish = async (bizId, result) => {
        try {
            await onDone(bizId, result);
        } catch (err) {
            log.exception(err, `Finalizing Meta result for ${bizId} failed`);
        }
    };

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxConcurrency,
        // Requests are added while other checks run; the caller stops the crawler when done.
        keepAlive: true,
        maxRequestRetries: 2,
        navigationTimeoutSecs: 45,
        requestHandlerTimeoutSecs: 100,
        useSessionPool: true,
        persistCookiesPerSession: true,
        sessionPoolOptions: { maxPoolSize: 100, sessionOptions: { maxUsageCount: 20 } },
        browserPoolOptions: {
            useFingerprints: true,
            fingerprintOptions: {
                fingerprintGeneratorOptions: {
                    browsers: ['chrome'],
                    devices: ['desktop'],
                    operatingSystems: ['windows', 'macos'],
                    locales: ['en-US'],
                },
            },
        },
        launchContext: {
            launchOptions: { headless: true, args: ['--disable-dev-shm-usage', '--lang=en-US'], ...launchOptions },
        },
        preNavigationHooks: [
            async ({ page, request }, gotoOptions) => {
                if (request.userData.attempt !== attempt || !getContext(request.userData.bizId)) {
                    request.skipNavigation = true; // stale request from before a migration
                    return;
                }
                gotoOptions.waitUntil = 'domcontentloaded';
                const bucket = { texts: [], pending: [] };
                buckets.set(page, bucket);
                page.on('response', (res) => {
                    if (!/\/api\/graphql\/?/.test(res.url())) return;
                    bucket.pending.push(res.text().then((t) => { bucket.texts.push(t); }).catch(() => {}));
                });
                await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
                await playwrightUtils.blockRequests(page, { urlPatterns: BLOCK_PATTERNS }).catch(() => {});
            },
        ],
        requestHandler: async ({ page, request, response, session }) => {
            const { bizId, label } = request.userData;
            const ctx = request.userData.attempt === attempt ? getContext(bizId) : null;
            if (!ctx) return; // left over from a previous (migrated) run attempt

            const finalUrl = page.url();
            if (/\/(login|checkpoint)(\/|\.php|\?|$)/.test(finalUrl)) {
                session?.retire();
                // Page profiles are often behind a login wall for logged-out visitors.
                // Retry once with a new IP, then fall back to the Ad Library keyword search.
                if (label === 'FB_PAGE' && request.retryCount >= 1 && ctx.keywordFallback && ctx.query) {
                    await enqueueKeyword(crawler, { bizId, attempt, query: ctx.query, country });
                    return;
                }
                throw new Error(`Meta redirected to a login wall (${finalUrl}); retrying with a new IP`);
            }
            const bucket = buckets.get(page) ?? { texts: [], pending: [] };
            const html = response ? await response.text().catch(() => '') : '';

            if (label === 'FB_PAGE') {
                const found = extractPageIdFromHtml(html) ?? extractPageIdFromHtml(await page.content().catch(() => ''));
                if (found) {
                    await enqueuePage(crawler, { bizId, attempt, pageId: found.pageId, country, via: `facebook_page_html:${found.method}`, pageName: found.pageName });
                    return;
                }
                if (/temporarily blocked|you['’]re temporarily/i.test(html)) {
                    session?.retire();
                    throw new Error('Meta temporarily blocked this IP');
                }
                if (ctx.keywordFallback && ctx.query) {
                    await enqueueKeyword(crawler, { bizId, attempt, query: ctx.query, country });
                    return;
                }
                await finish(bizId, { ...emptyMetaResult(), checked: true, error: 'Could not resolve the Facebook page ID from the page URL.' });
                return;
            }

            const state = await collectAdLibrary(page, html, bucket, { wantAds: label === 'ADLIB_KEYWORD' ? 60 : Math.max(ctx.maxSampleAds, 30) });

            if (label === 'ADLIB_KEYWORD') {
                const ads = [...state.ads.values()].map(parseMetaAd);
                const { best, candidates } = pickAdvertiser(ads, { domains: ctx.domains, name: ctx.name, facebookSlug: ctx.biz.facebook?.slug });
                const previous = request.userData.zeroResult;
                if (best && previous && best.pageId === previous.pageId) {
                    await finish(bizId, previous);
                    return;
                }
                if (best) {
                    await enqueuePage(crawler, {
                        bizId, attempt, pageId: best.pageId, country, via: best.method, confidence: best.confidence, pageName: best.pageName, candidates,
                    });
                    return;
                }
                if (previous) {
                    await finish(bizId, previous);
                    return;
                }
                const result = { ...emptyMetaResult(), checked: true, matchMethod: 'keyword_search', matchConfidence: 'low' };
                result.adLibraryUrl = request.url;
                result.note = ads.length
                    ? `Keyword search returned ${ads.length} ads, but none could be attributed to this business.`
                    : 'Keyword search returned no active ads.';
                if (ctx.includeDebugInfo) result.debug = { candidates };
                await finish(bizId, result);
                return;
            }

            // ADLIB_PAGE
            const summary = summarizeMetaAds([...state.ads.values()], {
                totalCount: state.totalCount,
                domCount: state.domCount,
                hasNextPage: state.hasNextPage,
                windowDays: ctx.windowDays,
                maxSampleAds: ctx.maxSampleAds,
            });
            const firstAd = state.ads.size ? parseMetaAd(state.ads.values().next().value) : null;
            const via = request.userData.via ?? 'page_id';
            const result = {
                ...emptyMetaResult(),
                ...summary,
                checked: true,
                matchMethod: via,
                matchConfidence: request.userData.confidence ?? 'high',
                pageId: request.userData.pageId,
                pageName: firstAd?.pageName ?? request.userData.pageName ?? null,
                pageUrl: firstAd?.pageProfileUri ?? `https://www.facebook.com/${request.userData.pageId}`,
                adLibraryUrl: request.url,
            };
            if (!state.ads.size && state.totalCount == null && state.domCount == null && !state.noResults) {
                // Nothing parseable at all: likely a soft block or a layout we do not understand.
                session?.retire();
                throw new Error('Meta Ad Library page loaded but no results data was found');
            }
            if (ctx.includeDebugInfo) result.debug = { candidates: request.userData.candidates ?? null };
            // A page ID read from a profile-style field may not be the ID the Ad Library
            // uses. Before reporting "no ads", get a second opinion from keyword search.
            const weakId = /userID|al_profile/.test(via);
            if (!result.isRunningAds && weakId && ctx.keywordFallback && ctx.query) {
                await enqueueKeyword(crawler, { bizId, attempt, query: ctx.query, country, zeroResult: result });
                return;
            }
            await finish(bizId, result);
        },
        failedRequestHandler: async ({ request }, error) => {
            const { bizId } = request.userData;
            if (request.userData.attempt !== attempt || !getContext(bizId)) return;
            await finish(bizId, { ...emptyMetaResult(), checked: true, error: `Meta check failed: ${errorMessage(error)}` });
        },
    });
    return crawler;
}

async function collectAdLibrary(page, html, bucket, { wantAds }) {
    const state = newCollectState();
    collectFromDocuments(parseJsonDocuments(html), state);

    const started = Date.now();
    let scrolls = 0;
    while (Date.now() - started < WAIT_MAX_MS) {
        await Promise.allSettled(bucket.pending.splice(0));
        for (const text of bucket.texts.splice(0)) collectFromDocuments(parseJsonDocuments(text), state);
        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 20000) ?? '').catch(() => '');
        const { domCount, noResults } = parseResultsText(bodyText);
        if (domCount != null) state.domCount = domCount;
        if (noResults) state.noResults = true;

        const haveCount = state.totalCount != null || state.domCount != null;
        if (state.noResults && !state.ads.size) break;
        if (haveCount && (state.ads.size >= Math.min(wantAds, state.totalCount ?? state.domCount ?? 0) || state.hasNextPage === false)) break;
        if (state.ads.size >= wantAds) break;
        if (state.ads.size && state.hasNextPage && scrolls < 3) {
            scrolls++;
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
        }
        await page.waitForTimeout(700);
    }
    await Promise.allSettled(bucket.pending.splice(0));
    for (const text of bucket.texts.splice(0)) collectFromDocuments(parseJsonDocuments(text), state);
    return state;
}

export async function enqueuePage(crawler, { bizId, attempt, pageId, country, via, confidence, pageName, candidates }) {
    const url = buildAdLibraryUrl({ pageId, country });
    await crawler.addRequests([{
        url,
        uniqueKey: `ADLIB_PAGE:${attempt}:${bizId}:${pageId}`,
        userData: { label: 'ADLIB_PAGE', bizId, attempt, pageId, via, confidence: confidence ?? 'high', pageName, candidates },
    }]);
}

export async function enqueueKeyword(crawler, { bizId, attempt, query, country, zeroResult }) {
    await crawler.addRequests([{
        url: buildAdLibraryUrl({ query, country }),
        uniqueKey: `ADLIB_KEYWORD:${attempt}:${bizId}`,
        userData: { label: 'ADLIB_KEYWORD', bizId, attempt, zeroResult },
    }]);
}

export async function enqueueFacebookPage(crawler, { bizId, attempt, slug }) {
    await crawler.addRequests([{
        url: `https://www.facebook.com/${encodeURIComponent(slug)}`,
        uniqueKey: `FB_PAGE:${attempt}:${bizId}`,
        userData: { label: 'FB_PAGE', bizId, attempt },
    }]);
}

/** Builds the first request for a business, or null if Meta cannot be checked. */
export function firstMetaRequest(ctx, { attempt, country }) {
    const { biz } = ctx;
    if (biz.facebook?.pageId) {
        const url = buildAdLibraryUrl({ pageId: biz.facebook.pageId, country });
        const via = biz.facebook.source === 'cache'
            ? `${ctx.cached?.via ?? 'page_id'}:cached`
            : (biz.facebook.source === 'input' ? 'page_id_input' : 'page_id_website');
        return {
            url,
            uniqueKey: `ADLIB_PAGE:${attempt}:${biz.id}:${biz.facebook.pageId}`,
            userData: {
                label: 'ADLIB_PAGE', bizId: biz.id, attempt, pageId: biz.facebook.pageId,
                via, confidence: ctx.cached?.confidence ?? 'high', pageName: ctx.cached?.pageName ?? null,
            },
        };
    }
    if (biz.facebook?.slug) {
        return {
            url: `https://www.facebook.com/${encodeURIComponent(biz.facebook.slug)}`,
            uniqueKey: `FB_PAGE:${attempt}:${biz.id}`,
            userData: { label: 'FB_PAGE', bizId: biz.id, attempt },
        };
    }
    if (ctx.keywordFallback && ctx.query) {
        return {
            url: buildAdLibraryUrl({ query: ctx.query, country }),
            uniqueKey: `ADLIB_KEYWORD:${attempt}:${biz.id}`,
            userData: { label: 'ADLIB_KEYWORD', bizId: biz.id, attempt },
        };
    }
    return null;
}
