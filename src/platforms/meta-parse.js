// Pure parsing helpers for the Meta Ad Library (no browser code here, so they
// are unit-testable).
//
// The Ad Library page delivers results in two places: JSON embedded in the
// initial HTML (<script type="application/json">) and later GraphQL responses
// (/api/graphql/). Instead of hard-coding wrapper paths, which Meta changes
// often, we walk any JSON we receive and pick up every object that looks like
// a search connection or an ad.

import { parseFacebookUrl, registrableDomain } from '../utils/domain.js';
import { nameSimilarity, truncate } from '../utils/text.js';

const AD_LIBRARY = 'https://www.facebook.com/ads/library/';

export function buildAdLibraryUrl({ pageId, query, country = 'ALL' }) {
    const params = new URLSearchParams({
        active_status: 'active',
        ad_type: 'all',
        country: country || 'ALL',
        is_targeted_country: 'false',
        media_type: 'all',
    });
    if (pageId) {
        params.set('search_type', 'page');
        params.set('view_all_page_id', pageId);
    } else {
        params.set('q', query);
        params.set('search_type', 'keyword_unordered');
    }
    return `${AD_LIBRARY}?${params.toString()}`;
}

/** Splits a GraphQL/HTML payload into parsed JSON documents. */
export function parseJsonDocuments(text) {
    if (!text) return [];
    const docs = [];
    const trimmed = text.replace(/^for \(;;\);/, '').trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        // GraphQL can stream several JSON objects separated by newlines.
        for (const line of trimmed.split(/\r?\n(?=[{[])/)) {
            try {
                docs.push(JSON.parse(line));
            } catch {
                // ignore partial chunks
            }
        }
        return docs;
    }
    // HTML: extract embedded JSON scripts that may contain ad data.
    const re = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
    for (const m of text.matchAll(re)) {
        const body = m[1];
        if (!body.includes('ad_archive_id') && !body.includes('search_results_connection')) continue;
        try {
            docs.push(JSON.parse(body));
        } catch {
            // ignore
        }
    }
    return docs;
}

/**
 * Walks JSON documents and accumulates ads + total counts into `state`.
 * state = { ads: Map<id, raw>, totalCount: number|null, hasNextPage: boolean|null }
 */
export function collectFromDocuments(docs, state = newCollectState()) {
    const stack = [...docs];
    let guard = 0;
    while (stack.length && guard++ < 500_000) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node)) {
            for (const v of node) if (v && typeof v === 'object') stack.push(v);
            continue;
        }
        const conn = node.search_results_connection;
        if (conn && typeof conn === 'object') {
            if (Number.isFinite(conn.count)) {
                state.totalCount = Math.max(state.totalCount ?? 0, conn.count);
            }
            if (conn.page_info && typeof conn.page_info.has_next_page === 'boolean') {
                state.hasNextPage = conn.page_info.has_next_page;
            }
        }
        if (node.ad_archive_id != null && (node.snapshot || node.page_id || node.page_name)) {
            const id = String(node.ad_archive_id);
            if (!state.ads.has(id)) state.ads.set(id, node);
        }
        for (const v of Object.values(node)) if (v && typeof v === 'object') stack.push(v);
    }
    return state;
}

export function newCollectState() {
    return { ads: new Map(), totalCount: null, hasNextPage: null, domCount: null, noResults: false };
}

/** Reads "~1,200 results" / "1 result" / "No ads match" from the rendered page text. */
export function parseResultsText(text) {
    if (!text) return { domCount: null, noResults: false };
    const noResults = /No ads match|no results|isn['’]t running ads|\b0 results|no ads (?:to show|found|available)|doesn['’]t have any (?:active )?ads/i.test(text);
    const m = text.match(/~?\s?([\d][\d.,]*)\s*([KkMm])?\s+results?\b/);
    if (!m) return { domCount: noResults ? 0 : null, noResults };
    let n = Number.parseFloat(m[1].replace(/,/g, ''));
    if (m[2] && /k/i.test(m[2])) n *= 1_000;
    if (m[2] && /m/i.test(m[2])) n *= 1_000_000;
    return { domCount: Number.isFinite(n) ? Math.round(n) : null, noResults: noResults && n === 0 };
}

function epochToIso(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date((n < 1e12 ? n * 1000 : n)).toISOString();
}

function unwrapFacebookRedirect(url) {
    if (!url || typeof url !== 'string') return null;
    try {
        const u = new URL(url);
        if (/(^|\.)facebook\.com$/i.test(u.hostname) && u.pathname.startsWith('/l.php')) {
            return u.searchParams.get('u') || url;
        }
        return url;
    } catch {
        return null;
    }
}

function stripHtml(s) {
    return typeof s === 'string' ? s.replace(/<[^>]+>/g, ' ') : null;
}

export function parseMetaAd(raw) {
    const s = raw.snapshot ?? {};
    const card = Array.isArray(s.cards) && s.cards.length ? s.cards[0] : {};
    const body = s.body?.text ?? stripHtml(s.body?.markup?.__html) ?? card.body ?? null;
    const linkUrl = unwrapFacebookRedirect(s.link_url ?? card.link_url ?? null);
    const image = s.images?.[0]?.original_image_url ?? s.images?.[0]?.resized_image_url
        ?? card.original_image_url ?? card.resized_image_url
        ?? s.videos?.[0]?.video_preview_image_url ?? card.video_preview_image_url ?? null;
    const id = String(raw.ad_archive_id);
    return {
        adArchiveId: id,
        pageId: raw.page_id != null ? String(raw.page_id) : (s.page_id != null ? String(s.page_id) : null),
        pageName: raw.page_name ?? s.page_name ?? null,
        pageProfileUri: s.page_profile_uri ?? null,
        pageLikeCount: Number.isFinite(s.page_like_count) ? s.page_like_count : null,
        isActive: typeof raw.is_active === 'boolean' ? raw.is_active : null,
        startDate: epochToIso(raw.start_date),
        endDate: epochToIso(raw.end_date),
        publisherPlatforms: Array.isArray(raw.publisher_platform) ? raw.publisher_platform
            : (Array.isArray(raw.publisher_platforms) ? raw.publisher_platforms : []),
        displayFormat: s.display_format ?? null,
        title: truncate(s.title ?? card.title, 200),
        body: truncate(body, 500),
        ctaText: s.cta_text ?? card.cta_text ?? null,
        ctaType: s.cta_type ?? card.cta_type ?? null,
        linkUrl,
        landingDomain: registrableDomain(linkUrl) ?? captionDomain(s.caption ?? card.caption),
        imageUrl: image,
        collationCount: Number.isFinite(raw.collation_count) ? raw.collation_count : null,
        adLibraryUrl: `${AD_LIBRARY}?id=${id}`,
    };
}

function captionDomain(caption) {
    if (!caption || typeof caption !== 'string' || /\s/.test(caption.trim())) return null;
    return registrableDomain(caption.trim().toLowerCase());
}

/**
 * Picks the advertiser (Facebook page) behind keyword-search ads.
 * Strong evidence: the ad links to the business's domain or the page's vanity
 * URL equals the known Facebook slug. Weak evidence: page name similarity.
 */
export function pickAdvertiser(ads, { domains = [], name, facebookSlug }) {
    const wanted = new Set(domains.filter(Boolean).map((d) => d.toLowerCase()));
    const slug = facebookSlug?.toLowerCase() ?? null;
    const byPage = new Map();
    for (const ad of ads) {
        if (!ad.pageId) continue;
        const c = byPage.get(ad.pageId) ?? {
            pageId: ad.pageId, pageName: ad.pageName, pageProfileUri: ad.pageProfileUri, ads: 0, domains: new Set(),
        };
        c.ads++;
        if (ad.landingDomain) c.domains.add(ad.landingDomain);
        c.pageProfileUri ??= ad.pageProfileUri;
        byPage.set(ad.pageId, c);
    }
    const candidates = [...byPage.values()].map((c) => {
        const pageSlug = c.pageProfileUri ? parseFacebookUrl(c.pageProfileUri)?.slug?.toLowerCase() : null;
        const slugMatch = Boolean(slug && pageSlug && slug === pageSlug);
        const domainMatch = [...c.domains].some((d) => wanted.has(d));
        const similarity = name ? nameSimilarity(c.pageName, name) : 0;
        let score = Math.max(slugMatch ? 1 : 0, domainMatch ? 0.95 : 0, similarity * 0.9);
        score += Math.min(c.ads, 20) / 1000; // tie-breaker only
        let confidence = 'low';
        if (slugMatch || domainMatch) confidence = 'high';
        else if (similarity >= 0.97) confidence = 'medium';
        const method = slugMatch ? 'facebook_slug' : domainMatch ? 'landing_page_domain' : 'page_name';
        return {
            pageId: c.pageId,
            pageName: c.pageName,
            pageProfileUri: c.pageProfileUri,
            adsInSearch: c.ads,
            landingDomains: [...c.domains].slice(0, 5),
            similarity: Math.round(similarity * 100) / 100,
            score,
            confidence,
            method,
        };
    }).sort((a, b) => b.score - a.score);

    const best = candidates[0];
    const accepted = best && best.score >= 0.76 ? best : null;
    return { best: accepted, candidates: candidates.slice(0, 5) };
}

/** Extracts a page ID from the HTML of facebook.com/<vanity>. */
export function extractPageIdFromHtml(html) {
    if (!html) return null;
    const rules = [
        [/"delegate_page":\{[^{}]*?"id":"(\d{5,})"/, 'delegate_page'],
        [/"pageID":"(\d{5,})"/, 'pageID'],
        [/"page_id":"(\d{5,})"/, 'page_id'],
        [/fb:\/\/page\/\?id=(\d{5,})/, 'al_android_page'],
        [/fb:\/\/page\/(\d{5,})/, 'al_ios_page'],
        [/"associated_page_id":"(\d{5,})"/, 'associated_page_id'],
        [/"userID":"(\d{5,})"/, 'userID'],
        [/fb:\/\/profile\/(\d{5,})/, 'al_profile'],
    ];
    for (const [re, method] of rules) {
        const m = html.match(re);
        if (m) {
            const name = html.match(/<meta property="og:title" content="([^"]{1,150})"/)?.[1] ?? null;
            return { pageId: m[1], method, pageName: name ? decodeHtml(name) : null };
        }
    }
    return null;
}

function decodeHtml(s) {
    return s.replace(/&amp;/g, '&').replace(/&#039;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Builds the Meta section of the output from the ads seen on a page-scoped query. */
export function summarizeMetaAds(rawAds, { totalCount, domCount, hasNextPage, windowDays, maxSampleAds, now = Date.now() }) {
    const ads = rawAds.map(parseMetaAd).filter((a) => a.isActive !== false);
    const count = totalCount ?? domCount ?? null;
    const activeAdsCount = count != null ? Math.max(count, ads.length) : ads.length;
    const starts = ads.map((a) => Date.parse(a.startDate)).filter(Number.isFinite);
    const cutoff = now - windowDays * 86400_000;
    const platforms = new Set();
    const formats = {};
    const ctas = {};
    const domains = {};
    for (const a of ads) {
        for (const p of a.publisherPlatforms) platforms.add(String(p).toUpperCase());
        if (a.displayFormat) formats[a.displayFormat] = (formats[a.displayFormat] ?? 0) + 1;
        if (a.ctaText) ctas[a.ctaText] = (ctas[a.ctaText] ?? 0) + 1;
        if (a.landingDomain) domains[a.landingDomain] = (domains[a.landingDomain] ?? 0) + 1;
    }
    const oldest = starts.length ? Math.min(...starts) : null;
    const newest = starts.length ? Math.max(...starts) : null;
    const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
    return {
        isRunningAds: activeAdsCount > 0,
        activeAdsCount,
        countIsLowerBound: count == null && Boolean(hasNextPage),
        adsAnalyzed: ads.length,
        adsStartedInWindow: starts.filter((t) => t >= cutoff).length,
        oldestActiveAdStartDate: oldest ? new Date(oldest).toISOString() : null,
        newestActiveAdStartDate: newest ? new Date(newest).toISOString() : null,
        longestRunningAdDays: oldest ? Math.floor((now - oldest) / 86400_000) : null,
        publisherPlatforms: [...platforms],
        displayFormats: formats,
        topCallsToAction: top(ctas, 5),
        landingDomains: top(domains, 5),
        sampleAds: [...ads]
            .sort((a, b) => Date.parse(b.startDate ?? 0) - Date.parse(a.startDate ?? 0))
            .slice(0, maxSampleAds)
            .map(({ adArchiveId, startDate, publisherPlatforms, displayFormat, title, body, ctaText, linkUrl, imageUrl, adLibraryUrl }) => ({
                adArchiveId, startDate, publisherPlatforms, displayFormat, title, body, ctaText, linkUrl, imageUrl, adLibraryUrl,
            })),
        adRefs: ads.map((a) => ({ id: a.adArchiveId, start: a.startDate })),
    };
}
