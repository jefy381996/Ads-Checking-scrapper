// LinkedIn Ad Library (https://www.linkedin.com/ad-library). The search page
// is server-rendered and public, so plain HTTP is enough. The markup is parsed
// loosely: ad cards are found through their stable "/ad-library/detail/<id>"
// links, then the advertiser is read from the company link inside each card.

import * as cheerio from 'cheerio';

import { parseLinkedInCompany } from '../utils/domain.js';
import { errorMessage, fetchText } from '../utils/http.js';
import { nameSimilarity, truncate } from '../utils/text.js';

const BASE = 'https://www.linkedin.com/ad-library';
const PAGE_SIZE_HINT = 24;

export function emptyLinkedInResult() {
    return {
        checked: false,
        isRunningAds: false,
        matchMethod: null,
        matchConfidence: null,
        advertiserName: null,
        adsFound: 0,
        countIsLowerBound: false,
        adLibraryUrl: null,
        sampleAds: [],
        adDetails: [],
        error: null,
    };
}

export function buildLinkedInUrl({ name, country, windowDays, now = new Date() }) {
    const params = new URLSearchParams({ accountOwner: name });
    params.set('countries', !country || country === 'ALL' ? 'ALL' : country);
    if (windowDays === 30) {
        params.set('dateOption', 'last-30-days');
    } else {
        const start = new Date(now.getTime() - windowDays * 86400_000);
        params.set('dateOption', 'custom-date-range');
        params.set('startdate', start.toISOString().slice(0, 10));
        params.set('enddate', now.toISOString().slice(0, 10));
    }
    return `${BASE}/search?${params.toString()}`;
}

export function parseLinkedInSearch(html) {
    const $ = cheerio.load(html);
    const ads = new Map();
    $('a[href*="/ad-library/detail/"]').each((_, el) => {
        const href = $(el).attr('href') ?? '';
        const id = href.match(/\/ad-library\/detail\/(\d+)/)?.[1];
        if (!id || ads.has(id)) return;
        const card = $(el).closest('li, article, [class*="ad-preview"], [class*="search-result"], [data-ad-id]');
        const scope = card.length ? card : $(el).parent();
        const companyLink = scope.find('a[href*="/company/"]').first();
        const advertiserName = truncate(
            companyLink.text()
            || scope.find('[class*="advertiser"], [class*="sponsored-content-headline"], [class*="company-name"]').first().text(),
            120,
        );
        ads.set(id, {
            adId: id,
            advertiserName,
            advertiserSlug: parseLinkedInCompany(companyLink.attr('href') ?? ''),
            body: truncate(scope.find('[class*="commentary"], [class*="ad-copy"], p').first().text(), 300),
            url: `${BASE}/detail/${id}`,
        });
    });
    const pageText = $('body').text().replace(/\s+/g, ' ');
    const noResults = /no ads (?:to show|found|match)|did(?:n['’]t| not) find any ads|0 results/i.test(pageText);
    return { ads: [...ads.values()], noResults };
}

const DATE_RE = '(?:[A-Z][a-z]{2,8}\\.? \\d{1,2}, \\d{4}|\\d{1,2}/\\d{1,2}/\\d{4}|\\d{4}-\\d{2}-\\d{2})';

/** Text in document order with a space between nodes (cheerio's .text() glues "country" + "Germany"). */
function spacedText(root) {
    const out = [];
    const walk = (node) => {
        if (node.type === 'text') out.push(node.data);
        else if (node.type !== 'script' && node.type !== 'style') for (const child of node.children ?? []) walk(child);
    };
    if (root) walk(root);
    return out.join(' ').replace(/\s+/g, ' ').trim();
}

function parseQuantity(text) {
    const m = String(text).replace(/,/g, '').trim().match(/^([\d.]+)\s*([kKmM])?$/);
    if (!m) return null;
    let n = Number.parseFloat(m[1]);
    if (/k/i.test(m[2] ?? '')) n *= 1_000;
    if (/m/i.test(m[2] ?? '')) n *= 1_000_000;
    return Number.isFinite(n) ? Math.round(n) : null;
}

function toIsoDate(text) {
    if (!text || /present|now/i.test(text)) return null;
    const t = Date.parse(text);
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

/**
 * Parses an ad detail page (/ad-library/detail/<id>). For ads shown in the EU,
 * LinkedIn publishes an impression range, run dates and a per-country split.
 */
export function parseLinkedInAdDetail(html) {
    const $ = cheerio.load(html);
    const text = spacedText($('body')[0] ?? $.root()[0]);
    let impressions = null;
    const m = text.match(/impressions?\s*:?\s*(<\s*)?([\d.,]+\s*[kKmM]?)(?:\s*(?:-|–|to)\s*([\d.,]+\s*[kKmM]?))?/i);
    if (m) {
        const a = parseQuantity(m[2]);
        const b = m[3] ? parseQuantity(m[3]) : null;
        if (a != null) {
            impressions = m[1] ? { low: 0, high: a } : { low: a, high: b ?? a };
            impressions.text = m[0].replace(/^impressions?\s*:?\s*/i, '').trim();
        }
    }
    const ran = text.match(new RegExp(`Ran from\\s+(${DATE_RE})\\s+to\\s+(${DATE_RE}|present|now)`, 'i'));
    const countries = [];
    const idx = text.search(/impressions?\s+by\s+country|country\s+breakdown|location/i);
    if (idx >= 0) {
        for (const c of text.slice(idx, idx + 1500).matchAll(/([A-Z][A-Za-z.'\- ]{2,30}?)\s+(<\s*1|\d{1,3})\s?%/g)) {
            const name = c[1].replace(/^.*\b(?:country|countries|location|locations)\b\s*/i, '').trim();
            if (!name || /impressions/i.test(name)) continue;
            countries.push({ country: name, share: /</.test(c[2]) ? 0.005 : Number(c[2]) / 100 });
            if (countries.length >= 10) break;
        }
    }
    let paidBy = null;
    $('*').filter((_, el) => $(el).children().length === 0 && /paid for by/i.test($(el).text())).each((_, el) => {
        if (paidBy) return;
        const rest = $(el).text().replace(/.*paid for by\s*:?\s*/i, '').trim();
        paidBy = rest || $(el).next().text().trim() || null;
    });
    return {
        impressions,
        ranFrom: ran ? toIsoDate(ran[1]) : null,
        ranTo: ran ? toIsoDate(ran[2]) : null,
        topCountries: countries,
        paidBy: truncate(paidBy, 120),
    };
}

async function fetchLinkedInAdDetails(ads, { proxyConfiguration, bizId, limit }) {
    const details = [];
    for (const ad of ads.slice(0, limit)) {
        try {
            const res = await fetchText(ad.url, { proxyConfiguration, sessionId: `lid_${bizId}_${ad.adId}`, retries: 1, timeoutMs: 20_000 });
            if (res.statusCode >= 400) continue;
            details.push({ adId: ad.adId, url: ad.url, ...parseLinkedInAdDetail(res.body) });
        } catch {
            // One failed detail page should not fail the whole LinkedIn check.
        }
    }
    return details;
}

export async function checkLinkedIn(biz, { name, country, windowDays, maxSampleAds, proxyConfiguration, detailLimit = 0 }) {
    const result = emptyLinkedInResult();
    result.checked = true;
    if (!name) {
        result.error = 'No business name available for the LinkedIn search.';
        return result;
    }
    const url = buildLinkedInUrl({ name, country, windowDays });
    result.adLibraryUrl = url;
    try {
        const res = await fetchText(url, { proxyConfiguration, sessionId: `li_${biz.id}`, retries: 3, timeoutMs: 25_000 });
        if (res.statusCode === 999 || res.statusCode === 429 || res.statusCode === 403) {
            result.error = `LinkedIn blocked the request (HTTP ${res.statusCode}). Try residential proxies.`;
            return result;
        }
        if (res.statusCode >= 400) {
            result.error = `LinkedIn returned HTTP ${res.statusCode}`;
            return result;
        }
        if (/authwall|uas\/login/i.test(res.url)) {
            result.error = 'LinkedIn redirected to the login wall. Try residential proxies.';
            return result;
        }
        const { ads } = parseLinkedInSearch(res.body);
        const attributed = attributeLinkedInAds(ads, { name, slug: biz.linkedinSlug, maxSampleAds: Math.max(maxSampleAds, detailLimit) });
        Object.assign(result, attributed);
        if (detailLimit > 0 && attributed.sampleAds.length) {
            result.adDetails = await fetchLinkedInAdDetails(attributed.sampleAds, { proxyConfiguration, bizId: biz.id, limit: detailLimit });
        }
        result.sampleAds = attributed.sampleAds.slice(0, maxSampleAds);
    } catch (err) {
        result.error = errorMessage(err);
    }
    return result;
}

/** LinkedIn's accountOwner filter is a fuzzy "contains" match, so verify each advertiser. */
export function attributeLinkedInAds(ads, { name, slug, maxSampleAds }) {
    const withAdvertiser = ads.filter((a) => a.advertiserName || a.advertiserSlug);
    let matched;
    let confidence;
    let method;
    if (!ads.length) {
        matched = [];
        confidence = slug ? 'medium' : 'low';
        method = 'advertiser_name';
    } else if (!withAdvertiser.length) {
        // Markup changed and no advertiser could be read: keep LinkedIn's own filter result.
        matched = ads;
        confidence = 'low';
        method = 'linkedin_filter_only';
    } else {
        const bySlug = slug ? withAdvertiser.filter((a) => a.advertiserSlug === slug) : [];
        if (bySlug.length) {
            matched = bySlug;
            confidence = 'high';
            method = 'linkedin_company_slug';
        } else {
            const scored = withAdvertiser.map((a) => ({ a, sim: nameSimilarity(a.advertiserName, name) }));
            const exact = scored.filter((x) => x.sim >= 0.97).map((x) => x.a);
            const close = scored.filter((x) => x.sim >= 0.85).map((x) => x.a);
            matched = exact.length ? exact : close;
            confidence = exact.length ? 'medium' : 'low';
            method = 'advertiser_name';
        }
    }
    return {
        isRunningAds: matched.length > 0,
        matchMethod: method,
        matchConfidence: confidence,
        advertiserName: matched[0]?.advertiserName ?? null,
        adsFound: matched.length,
        countIsLowerBound: ads.length >= PAGE_SIZE_HINT,
        sampleAds: matched.slice(0, maxSampleAds),
    };
}
