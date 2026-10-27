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

export async function checkLinkedIn(biz, { name, country, windowDays, maxSampleAds, proxyConfiguration }) {
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
        Object.assign(result, attributeLinkedInAds(ads, { name, slug: biz.linkedinSlug, maxSampleAds }));
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
