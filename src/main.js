import { Actor, log } from 'apify';

import { normalizeBusinesses, slimImportedItem } from './input.js';
import { buildSnapshot, diffSnapshots, monitorKey } from './monitor.js';
import { checkGoogle, emptyGoogleResult } from './platforms/google.js';
import { checkLinkedIn, emptyLinkedInResult } from './platforms/linkedin.js';
import { createMetaCrawler, emptyMetaResult, firstMetaRequest } from './platforms/meta.js';
import { evaluate, outreachSnippet } from './scoring.js';
import { domainLabel, parseFacebookUrl, parseLinkedInCompany } from './utils/domain.js';
import { errorMessage, mapWithConcurrency } from './utils/http.js';
import { emptyWebsiteResult, scanWebsite } from './website/scan.js';

// Pay-per-event names. Configure the same names in Apify Console > Monetization.
export const EVENTS = { BUSINESS: 'business-checked', META: 'meta-ads-checked' };
const PAGE_CACHE_STORE = 'ads-checker-page-cache';
const PAGE_CACHE_TTL_MS = 30 * 86400_000;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const cfg = {
    checkMeta: input.checkMeta ?? true,
    checkGoogle: input.checkGoogle ?? true,
    checkLinkedIn: input.checkLinkedIn ?? true,
    scanWebsite: input.scanWebsite ?? true,
    scanTagManagers: input.scanTagManagers ?? true,
    country: input.country ?? 'ALL',
    windowDays: clamp(input.activityWindowDays ?? 30, 1, 365),
    maxSampleAds: clamp(input.maxSampleAds ?? 3, 0, 25),
    discoverSocialProfiles: input.discoverSocialProfiles ?? true,
    keywordFallback: input.metaKeywordFallback ?? true,
    enableMonitoring: input.enableMonitoring ?? false,
    monitoringStoreName: input.monitoringStoreName || 'ads-checker-monitor',
    outputOnlyChanges: input.outputOnlyChanges ?? false,
    maxConcurrency: clamp(input.maxConcurrency ?? 10, 1, 50),
    metaMaxConcurrency: clamp(input.metaMaxConcurrency ?? 3, 1, 20),
    includeDebugInfo: input.includeDebugInfo ?? false,
    usePageCache: input.usePageCache ?? true,
};

const imported = await importDataset(input.importDatasetId, clamp(input.importMaxItems ?? 1000, 1, 100_000));
const { businesses: allBusinesses, skipped } = normalizeBusinesses({
    businesses: input.businesses,
    businessRecords: [...(Array.isArray(input.businessRecords) ? input.businessRecords : []), ...imported],
});
for (const s of skipped) log.warning(`Skipping "${typeof s.input === 'string' ? s.input : JSON.stringify(s.input)}": ${s.reason}`);
if (!allBusinesses.length) {
    await Actor.fail('No valid businesses in the input. Add domains, company names or Facebook page URLs to "Businesses to check".');
}

// Respect the user's max charge: assume each business can trigger every event.
const charging = Actor.getChargingManager();
const prices = charging.getPricingInfo().perEventPrices ?? {};
const unitPrice = (prices[EVENTS.BUSINESS] ?? 0) + (cfg.checkMeta ? (prices[EVENTS.META] ?? 0) : 0);
const maxTotal = charging.getPricingInfo().maxTotalChargeUsd;
const affordable = unitPrice > 0 && Number.isFinite(maxTotal) ? Math.floor(maxTotal / unitPrice + 1e-9) : Infinity;
const businesses = allBusinesses.slice(0, affordable);
if (businesses.length < allBusinesses.length) {
    log.warning(`Your maximum charge for this run ($${maxTotal}) covers ${businesses.length} of ${allBusinesses.length} businesses. The rest are skipped. Raise the limit to check them all.`);
}

const state = await Actor.useState('RUN_STATE', { done: {} });
const attempt = Date.now().toString(36);
const monitorStore = cfg.enableMonitoring ? await Actor.openKeyValueStore(cfg.monitoringStoreName) : null;
// Remembers which Facebook page belongs to which business across runs, which saves
// one browser page load per business on repeat and scheduled runs.
const pageCache = cfg.checkMeta && cfg.usePageCache ? await Actor.openKeyValueStore(PAGE_CACHE_STORE) : null;

const stats = {
    uniqueBusinesses: allBusinesses.length,
    skippedInvalidOrDuplicate: skipped.length,
    skippedBudget: allBusinesses.length - businesses.length,
    checked: 0,
    runningAds: 0,
    notRunningAds: 0,
    adPixelsOnly: 0,
    inconclusive: 0,
    activeOn: { meta: 0, google: 0, linkedin: 0 },
    changes: {},
    baselinesSaved: 0,
    pushed: 0,
};

const httpProxy = await createProxy(input.httpProxyConfiguration ?? { useApifyProxy: true }, 'HTTP');
const metaProxy = cfg.checkMeta
    ? await createProxy(input.proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }, 'Meta')
    : undefined;

/** @type {Map<string, any>} */
const records = new Map();
let metaPending = 0;
let httpStageDone = false;

const crawler = cfg.checkMeta
    ? createMetaCrawler({
        proxyConfiguration: metaProxy,
        maxConcurrency: cfg.metaMaxConcurrency,
        country: cfg.country,
        attempt,
        log,
        getContext: (bizId) => records.get(bizId)?.metaCtx ?? null,
        onDone: onMetaDone,
        // Local development only: point Playwright at an existing Chromium build.
        launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
    })
    : null;
// The crawler runs with keepAlive while the HTTP stage keeps adding Meta requests.
// If the browser itself dies (e.g. cannot launch), only the Meta check fails.
let crawlerError = null;
const crawlerRun = crawler
    ? crawler.run().catch(async (err) => {
        crawlerError = err;
        log.error(`The Meta browser crashed: ${errorMessage(err)}. Meta results for the remaining businesses will be marked as failed.`);
        for (const rec of records.values()) {
            if (rec.metaPending) await onMetaDone(rec.biz.id, metaFailure('The browser crashed before this check finished.'));
        }
    })
    : null;

const statusTimer = setInterval(() => {
    Actor.setStatusMessage(`Checked ${stats.checked}/${businesses.length} businesses, ${stats.runningAds} running ads`).catch(() => {});
}, 15_000);

log.info(`Checking ${businesses.length} businesses on: ${[cfg.checkMeta && 'Meta', cfg.checkGoogle && 'Google', cfg.checkLinkedIn && 'LinkedIn', cfg.scanWebsite && 'website pixels'].filter(Boolean).join(', ')}.`);

await mapWithConcurrency(businesses, cfg.maxConcurrency, async (biz) => {
    if (state.done[biz.key]) return; // finished before a migration/restart
    const rec = { biz, website: null, google: null, linkedin: null, meta: null, httpDone: false, metaPending: false, finalized: false };
    records.set(biz.id, rec);
    try {
        await processHttpStage(rec);
    } catch (err) {
        log.exception(err, `Unexpected error while checking ${label(biz)}`);
    }
    rec.httpDone = true;
    if (!rec.metaPending) await finalize(rec);
});
httpStageDone = true;
if (crawlerRun) {
    maybeStopCrawler();
    const watchdog = setInterval(maybeStopCrawler, 5_000);
    await crawlerRun;
    clearInterval(watchdog);
}

// Safety net: any business whose Meta lookup never reported back.
for (const rec of records.values()) {
    if (rec.metaPending) {
        rec.metaPending = false;
        rec.meta = metaFailure('Meta check did not complete.');
    }
    if (!rec.finalized) await finalize(rec);
}

clearInterval(statusTimer);
const summary = {
    ...stats,
    note: cfg.enableMonitoring && cfg.outputOnlyChanges && stats.changes.FIRST_CHECK
        ? `${stats.changes.FIRST_CHECK} businesses were checked for the first time; their baseline is saved and changes will appear in the dataset from the next run.`
        : undefined,
    finishedAt: new Date().toISOString(),
};
await Actor.setValue('SUMMARY', summary);
log.info('Done.', summary);
await Actor.exit(`Checked ${stats.checked} businesses: ${stats.runningAds} running ads, ${stats.notRunningAds} not running, ${stats.adPixelsOnly} with pixels only, ${stats.inconclusive} inconclusive.`);

// ---------------------------------------------------------------------------

async function processHttpStage(rec) {
    const { biz } = rec;
    rec.altDomains = [];

    if (cfg.scanWebsite && biz.domain) {
        rec.website = await scanWebsite(biz, { proxyConfiguration: httpProxy, scanTagManagers: cfg.scanTagManagers, log })
            .catch((err) => ({ ...emptyWebsiteResult(), checked: true, error: errorMessage(err) }));
        const site = rec.website;
        if (site.reachable) {
            if (site.finalDomain && site.finalDomain !== biz.domain) rec.altDomains.push(site.finalDomain);
            if (cfg.discoverSocialProfiles) {
                const fb = site.socialProfiles.facebook ? parseFacebookUrl(site.socialProfiles.facebook) : null;
                if (!biz.facebook && fb) biz.facebook = { slug: fb.slug, pageId: fb.pageId, source: 'website' };
                const li = site.socialProfiles.linkedin ? parseLinkedInCompany(site.socialProfiles.linkedin) : null;
                if (!biz.linkedinSlug && li) biz.linkedinSlug = li;
            }
        }
    }
    rec.searchName = pickSearchName(biz, rec.website);

    if (cfg.checkMeta) await startMeta(rec);

    const [google, linkedin] = await Promise.all([
        cfg.checkGoogle
            ? checkGoogle(biz, {
                name: rec.searchName, altDomains: rec.altDomains, country: cfg.country, windowDays: cfg.windowDays,
                maxSampleAds: cfg.maxSampleAds, proxyConfiguration: httpProxy,
            }).catch((err) => ({ ...emptyGoogleResult(), checked: true, error: errorMessage(err) }))
            : null,
        cfg.checkLinkedIn
            ? checkLinkedIn(biz, {
                name: rec.searchName, country: cfg.country, windowDays: cfg.windowDays,
                maxSampleAds: cfg.maxSampleAds, proxyConfiguration: httpProxy,
            }).catch((err) => ({ ...emptyLinkedInResult(), checked: true, error: errorMessage(err) }))
            : null,
    ]);
    rec.google = google;
    rec.linkedin = linkedin;
}

async function startMeta(rec) {
    const { biz } = rec;
    rec.metaCtx = {
        biz,
        name: rec.searchName,
        query: rec.searchName,
        domains: [biz.domain, ...rec.altDomains].filter(Boolean),
        windowDays: cfg.windowDays,
        maxSampleAds: cfg.maxSampleAds,
        keywordFallback: cfg.keywordFallback,
        includeDebugInfo: cfg.includeDebugInfo,
        cached: null,
    };
    if (pageCache && !biz.facebook?.pageId) {
        const cached = await pageCache.getValue(monitorKey(biz.key)).catch(() => null);
        if (cached?.pageId && Date.now() - Date.parse(cached.at) < PAGE_CACHE_TTL_MS) {
            rec.metaCtx.cached = cached;
            biz.facebook = { slug: biz.facebook?.slug ?? null, pageId: cached.pageId, source: 'cache' };
        }
    }
    if (crawlerError) {
        rec.meta = metaFailure('The browser is unavailable in this run.');
        return;
    }
    const request = firstMetaRequest(rec.metaCtx, { attempt, country: cfg.country });
    if (!request) {
        rec.meta = { ...emptyMetaResult(), note: 'Skipped: no Facebook page, and no name to search the Ad Library by.' };
        return;
    }
    rec.metaPending = true;
    metaPending++;
    try {
        await crawler.addRequests([request]);
    } catch (err) {
        rec.metaPending = false;
        metaPending--;
        rec.meta = metaFailure(`Could not queue the Meta check: ${errorMessage(err)}`);
    }
}

async function onMetaDone(bizId, result) {
    const rec = records.get(bizId);
    if (!rec || !rec.metaPending) return;
    rec.metaPending = false;
    metaPending--;
    rec.meta = result;
    if (rec.httpDone) await finalize(rec);
    maybeStopCrawler();
}

function maybeStopCrawler() {
    if (crawler && httpStageDone && metaPending <= 0) crawler.stop('All Meta checks are finished.');
}

async function finalize(rec) {
    if (rec.finalized) return;
    rec.finalized = true;
    const { biz } = rec;
    const checkedAt = new Date().toISOString();
    const metaRefs = rec.meta?.adRefs ?? [];
    const meta = rec.meta ? omit(rec.meta, ['adRefs']) : null;
    const evaluation = evaluate({ meta, google: rec.google, linkedin: rec.linkedin, website: rec.website }, { windowDays: cfg.windowDays });
    const businessName = biz.name ?? meta?.pageName ?? rec.website?.siteName ?? rec.searchName ?? null;

    const record = {
        businessName,
        domain: biz.domain,
        isRunningAds: evaluation.isRunningAds,
        verdict: evaluation.verdict,
        confidence: evaluation.confidence,
        activePlatforms: evaluation.activePlatforms,
        totalActiveAds: evaluation.totalActiveAds,
        advertiserScore: evaluation.advertiserScore,
        adIntensity: evaluation.adIntensity,
        signalCodes: evaluation.signalCodes,
        signals: evaluation.signals,
        outreachSnippet: outreachSnippet({
            name: businessName, domain: biz.domain, evaluation, meta, google: rec.google, linkedin: rec.linkedin,
        }),
        facebookPageUrl: meta?.pageUrl ?? (biz.facebook?.slug ? `https://www.facebook.com/${biz.facebook.slug}` : null),
        linkedinCompanyUrl: biz.linkedinSlug ? `https://www.linkedin.com/company/${biz.linkedinSlug}` : null,
        meta,
        google: rec.google,
        linkedin: rec.linkedin,
        website: rec.website,
        failedPlatforms: evaluation.failedPlatforms,
        input: typeof biz.input === 'string' ? biz.input : null,
        inputRecord: biz.inputRecord,
        checkedAt,
    };
    if (cfg.includeDebugInfo) {
        record.debug = { searchName: rec.searchName, altDomains: rec.altDomains, facebookSource: biz.facebook?.source ?? null };
    }

    if (monitorStore) {
        try {
            const key = monitorKey(biz.key);
            const previous = await monitorStore.getValue(key);
            const snapshot = buildSnapshot(record, { metaAds: metaRefs, previous });
            if (evaluation.verdict === 'INCONCLUSIVE') {
                // Never let a failed check become the baseline; surface it instead of staying silent.
                record.change = {
                    ...diffSnapshots(previous, previous ?? snapshot),
                    status: 'CHECK_FAILED',
                    summary: 'Every platform check failed this time. The previous state was kept, so re-run this business.',
                };
            } else {
                record.change = diffSnapshots(previous, snapshot);
                await monitorStore.setValue(key, snapshot);
                stats.baselinesSaved++;
            }
            stats.changes[record.change.status] = (stats.changes[record.change.status] ?? 0) + 1;
        } catch (err) {
            log.exception(err, `Monitoring state for ${label(biz)} could not be read or saved`);
        }
    }

    // Cache only confident matches proven by live ads, so a wrong match can never stick.
    const cacheable = okCheck(meta) && meta.isRunningAds && meta.pageId && ['high', 'medium'].includes(meta.matchConfidence)
        && !/cached|page_id_input/.test(meta.matchMethod ?? '');
    if (pageCache && cacheable) {
        await pageCache.setValue(monitorKey(biz.key), {
            pageId: meta.pageId, pageName: meta.pageName, via: meta.matchMethod, confidence: meta.matchConfidence, at: checkedAt,
        }).catch((err) => log.debug(`Page cache write failed: ${errorMessage(err)}`));
    }

    const quiet = record.change && ['NO_CHANGE', 'FIRST_CHECK'].includes(record.change.status);
    if (!(cfg.outputOnlyChanges && monitorStore && quiet)) {
        try {
            await Actor.pushData(record);
            stats.pushed++;
        } catch (err) {
            log.exception(err, `Saving the result for ${label(biz)} failed`);
        }
    }

    // Bill only for work that produced an answer; fully failed checks are free.
    try {
        const anySuccess = [rec.website?.reachable, okCheck(meta), okCheck(rec.google), okCheck(rec.linkedin)].some(Boolean);
        if (anySuccess) await Actor.charge({ eventName: EVENTS.BUSINESS });
        if (okCheck(meta)) await Actor.charge({ eventName: EVENTS.META });
    } catch (err) {
        log.exception(err, `Charging for ${label(biz)} failed`);
    }

    state.done[biz.key] = true;
    stats.checked++;
    if (evaluation.verdict === 'RUNNING_ADS') stats.runningAds++;
    else if (evaluation.verdict === 'NOT_RUNNING_ADS') stats.notRunningAds++;
    else if (evaluation.verdict === 'AD_PIXELS_ONLY') stats.adPixelsOnly++;
    else stats.inconclusive++;
    for (const p of evaluation.activePlatforms) stats.activeOn[p]++;
    log.info(`${label(biz)}: ${evaluation.verdict}${evaluation.activePlatforms.length ? ` (${evaluation.activePlatforms.join(', ')}, ${evaluation.totalActiveAds} ads)` : ''}`);
}

function metaFailure(error) {
    return { ...emptyMetaResult(), checked: true, error };
}

function okCheck(r) {
    return Boolean(r?.checked && !r.error);
}

function pickSearchName(biz, website) {
    if (biz.name) return biz.name;
    if (website?.siteName) return website.siteName;
    if (biz.domain) return domainLabel(biz.domain);
    if (website?.titleBrand) return website.titleBrand;
    if (biz.facebook?.slug) return biz.facebook.slug.replace(/[._-]+/g, ' ').trim();
    return null;
}

async function importDataset(datasetId, limit) {
    if (!datasetId) return [];
    try {
        const dataset = await Actor.openDataset(datasetId, { forceCloud: true });
        const items = [];
        for (let offset = 0; items.length < limit; offset += 1000) {
            const page = await dataset.getData({ offset, limit: Math.min(1000, limit - items.length), clean: true });
            items.push(...page.items.map(slimImportedItem));
            if (page.items.length < 1000) break;
        }
        log.info(`Imported ${items.length} items from dataset ${datasetId}.`);
        return items;
    } catch (err) {
        await Actor.fail(`Could not read dataset "${datasetId}": ${errorMessage(err)}`);
        return [];
    }
}

async function createProxy(options, purpose) {
    if (!Actor.isAtHome() && options?.useApifyProxy && !process.env.APIFY_PROXY_PASSWORD && !process.env.APIFY_TOKEN) {
        log.warning(`${purpose}: Apify Proxy needs APIFY_TOKEN or APIFY_PROXY_PASSWORD when running locally; continuing without a proxy.`);
        return undefined;
    }
    try {
        return await Actor.createProxyConfiguration(options);
    } catch (err) {
        if (Actor.isAtHome()) throw err;
        log.warning(`${purpose} proxy unavailable locally (${errorMessage(err)}); continuing without a proxy.`);
        return undefined;
    }
}

function label(biz) {
    return biz.name ?? biz.domain ?? biz.facebook?.slug ?? biz.facebook?.pageId ?? biz.key;
}

function omit(obj, keys) {
    const copy = { ...obj };
    for (const k of keys) delete copy[k];
    return copy;
}

function clamp(n, min, max) {
    const v = Number.parseInt(n, 10);
    if (!Number.isFinite(v)) return min;
    return Math.min(max, Math.max(min, v));
}
