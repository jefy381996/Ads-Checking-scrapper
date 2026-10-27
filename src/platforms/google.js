// Google Ads Transparency Center client.
//
// The public site (adstransparency.google.com) talks to an internal JSON RPC
// API under /anji/_/rpc/. Payloads and responses use protobuf-style numeric
// keys. Field positions below come from public open-source clients. Parsing is
// deliberately defensive: dates are found by scanning each creative for
// epoch-second values instead of trusting one field number.

import { readFileSync } from 'node:fs';
import { CookieJar } from 'tough-cookie';

import { errorMessage, fetchText } from '../utils/http.js';
import { nameSimilarity } from '../utils/text.js';

const BASE = 'https://adstransparency.google.com';
const GEO_IDS = JSON.parse(readFileSync(new URL('./google-geo-ids.json', import.meta.url), 'utf8'));
const FORMATS = { 1: 'TEXT', 2: 'IMAGE', 3: 'VIDEO' };
const PAGE_SIZE = 100;
const MIN_EPOCH = Date.UTC(2015, 0, 1) / 1000;

export function emptyGoogleResult() {
    return {
        checked: false,
        isRunningAds: false,
        matchMethod: null,
        matchConfidence: null,
        advertiserId: null,
        advertiserName: null,
        advertiserRegion: null,
        otherAdvertisers: [],
        creativesFound: 0,
        activeCreativesInWindow: 0,
        countIsLowerBound: false,
        adCountEstimate: null,
        activityBasis: null,
        firstShownDate: null,
        lastShownDate: null,
        daysSinceLastShown: null,
        formats: {},
        transparencyUrl: null,
        sampleAds: [],
        error: null,
    };
}

export function regionParam(country) {
    return !country || country === 'ALL' ? 'anywhere' : country;
}

export function geoId(country) {
    return !country || country === 'ALL' ? null : GEO_IDS[country] ?? null;
}

class TransparencyClient {
    constructor({ proxyConfiguration, sessionId, country }) {
        this.proxyConfiguration = proxyConfiguration;
        this.sessionId = sessionId;
        this.country = country;
        this.cookieJar = new CookieJar();
        this.warmedUp = false;
    }

    async warmUp() {
        if (this.warmedUp) return;
        this.warmedUp = true;
        try {
            await fetchText(`${BASE}/?region=${regionParam(this.country)}`, {
                proxyConfiguration: this.proxyConfiguration,
                sessionId: this.sessionId,
                cookieJar: this.cookieJar,
                retries: 1,
            });
        } catch {
            // Cookies help but are not strictly required.
        }
    }

    async rpc(service, method, payload) {
        await this.warmUp();
        const res = await fetchText(`${BASE}/anji/_/rpc/${service}/${method}?authuser=0`, {
            method: 'POST',
            form: { 'f.req': JSON.stringify(payload) },
            headers: {
                origin: BASE,
                referer: `${BASE}/?region=${regionParam(this.country)}`,
                'x-same-domain': '1',
            },
            proxyConfiguration: this.proxyConfiguration,
            sessionId: this.sessionId,
            cookieJar: this.cookieJar,
            retries: 2,
        });
        if (res.statusCode !== 200) throw new Error(`Google Transparency ${method} returned HTTP ${res.statusCode}`);
        return parseRpcJson(res.body);
    }

    async searchSuggestions(query) {
        const data = await this.rpc('SearchService', 'SearchSuggestions', { 1: query, 2: 10, 3: 10 });
        return parseSuggestions(data);
    }

    async searchCreatives({ domain, advertiserIds }) {
        const filter = {};
        if (domain) filter[12] = { 1: domain, 2: true };
        else filter[12] = { 1: '', 2: true };
        if (advertiserIds?.length) filter[13] = { 1: advertiserIds };
        const region = geoId(this.country);
        if (region) filter[8] = [region];
        const data = await this.rpc('SearchService', 'SearchCreatives', { 2: PAGE_SIZE, 3: filter, 7: { 1: 1 } });
        return {
            creatives: (Array.isArray(data?.[1]) ? data[1] : []).map(parseCreative).filter(Boolean),
            hasNextPage: Boolean(data?.[2]),
        };
    }
}

export function parseRpcJson(text) {
    const cleaned = String(text).replace(/^\)\]\}'\s*/, '').trim();
    if (!cleaned) return {};
    return JSON.parse(cleaned);
}

export function parseSuggestions(data) {
    const advertisers = [];
    const domains = [];
    for (const s of Array.isArray(data?.[1]) ? data[1] : []) {
        if (s?.[1]?.[2]) {
            advertisers.push({
                name: s[1][1] ?? null,
                id: s[1][2],
                region: typeof s[1][3] === 'string' ? s[1][3] : null,
                adCount: parseAdCount(s[1][4]),
            });
        } else if (s?.[2]?.[1]) {
            domains.push(String(s[2][1]).toLowerCase());
        }
    }
    return { advertisers, domains };
}

function parseAdCount(node) {
    const candidates = [node?.[2]?.[2], node?.[1]?.[2], node?.[2], node?.[1]];
    for (const c of candidates) {
        const n = Number.parseInt(c, 10);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    return null;
}

export function parseCreative(item) {
    if (!item || typeof item !== 'object') return null;
    const advertiserId = typeof item[1] === 'string' ? item[1] : null;
    const creativeId = typeof item[2] === 'string' ? item[2] : null;
    if (!advertiserId || !creativeId) return null;
    const epochs = collectEpochs(item);
    const first = epochs.length ? Math.min(...epochs) : null;
    const last = epochs.length ? Math.max(...epochs) : null;
    return {
        advertiserId,
        creativeId,
        advertiserName: typeof item[12] === 'string' ? item[12] : null,
        format: FORMATS[item[4]] ?? null,
        firstShown: first ? new Date(first * 1000).toISOString() : null,
        lastShown: last ? new Date(last * 1000).toISOString() : null,
        url: `${BASE}/advertiser/${advertiserId}/creative/${creativeId}`,
    };
}

function collectEpochs(node, out = [], depth = 0) {
    if (depth > 6 || node == null) return out;
    const maxEpoch = Date.now() / 1000 + 2 * 86400;
    if (typeof node === 'string' || typeof node === 'number') {
        const s = String(node);
        if (/^\d{10}$/.test(s)) {
            const n = Number(s);
            if (n >= MIN_EPOCH && n <= maxEpoch) out.push(n);
        }
        return out;
    }
    if (typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
            // Skip the IDs and the rendered creative content (field 3).
            if (depth === 0 && ['1', '2', '3', '12'].includes(key)) continue;
            collectEpochs(value, out, depth + 1);
        }
    }
    return out;
}

/** Checks one business against the Google Ads Transparency Center. */
export async function checkGoogle(biz, { name, altDomains = [], country, windowDays, maxSampleAds, proxyConfiguration }) {
    const result = emptyGoogleResult();
    result.checked = true;
    const client = new TransparencyClient({ proxyConfiguration, sessionId: `ggl_${biz.id}`, country });

    try {
        let creatives = [];
        let hasNextPage = false;

        // 1) Domain search: the most reliable way to attribute Google ads.
        for (const domain of [biz.domain, ...altDomains].filter(Boolean)) {
            const r = await client.searchCreatives({ domain });
            if (r.creatives.length) {
                ({ creatives, hasNextPage } = r);
                result.matchMethod = 'domain';
                result.matchConfidence = 'high';
                break;
            }
        }

        // 2) Advertiser-name search through the suggestion box.
        if (!creatives.length && name) {
            const { advertisers, domains } = await client.searchSuggestions(name);
            const best = advertisers
                .map((a) => ({ ...a, similarity: nameSimilarity(a.name, name) }))
                .filter((a) => a.similarity >= 0.85)
                .sort((a, b) => b.similarity - a.similarity || (b.adCount ?? 0) - (a.adCount ?? 0))[0];
            if (best) {
                const r = await client.searchCreatives({ advertiserIds: [best.id] });
                ({ creatives, hasNextPage } = r);
                result.matchMethod = 'advertiser_name';
                result.matchConfidence = best.similarity >= 0.97 ? 'medium' : 'low';
                result.adCountEstimate = best.adCount;
                result.advertiserRegion = best.region;
            } else if (!biz.domain && domains.length) {
                // The suggestion box sometimes knows the domain even if the advertiser name differs.
                const guess = domains.find((d) => nameSimilarity(d.split('.')[0], name) >= 0.9);
                if (guess) {
                    const r = await client.searchCreatives({ domain: guess });
                    ({ creatives, hasNextPage } = r);
                    if (creatives.length) {
                        result.matchMethod = 'suggested_domain';
                        result.matchConfidence = 'low';
                    }
                }
            }
        }

        if (!result.matchMethod) {
            result.matchMethod = biz.domain ? 'domain' : (name ? 'advertiser_name' : null);
            result.matchConfidence = biz.domain ? 'high' : 'low';
        }
        Object.assign(result, summarizeCreatives(creatives, { hasNextPage, windowDays, maxSampleAds }));
        if (result.activityBasis === 'creatives_listed_without_dates' && result.matchConfidence === 'high') {
            result.matchConfidence = 'medium';
        }
        result.transparencyUrl = result.advertiserId
            ? `${BASE}/advertiser/${result.advertiserId}?region=${regionParam(country)}`
            : (biz.domain ? `${BASE}/?region=${regionParam(country)}&domain=${encodeURIComponent(biz.domain)}` : null);
    } catch (err) {
        result.error = errorMessage(err);
    }
    return result;
}

export function summarizeCreatives(creatives, { hasNextPage, windowDays, maxSampleAds, now = Date.now() }) {
    const out = {
        creativesFound: creatives.length,
        countIsLowerBound: Boolean(hasNextPage),
        formats: {},
        sampleAds: [],
        otherAdvertisers: [],
        activeCreativesInWindow: 0,
        isRunningAds: false,
        activityBasis: null,
        firstShownDate: null,
        lastShownDate: null,
        daysSinceLastShown: null,
    };
    if (!creatives.length) return out;

    // Primary advertiser = the one with the most creatives for this domain/name.
    const byAdvertiser = new Map();
    for (const c of creatives) {
        const entry = byAdvertiser.get(c.advertiserId) ?? { id: c.advertiserId, name: c.advertiserName, count: 0 };
        entry.count++;
        byAdvertiser.set(c.advertiserId, entry);
    }
    const ranked = [...byAdvertiser.values()].sort((a, b) => b.count - a.count);
    out.advertiserId = ranked[0].id;
    out.advertiserName = ranked[0].name;
    out.otherAdvertisers = ranked.slice(1, 6).map(({ id, name, count }) => ({ id, name, creatives: count }));

    const cutoff = now - windowDays * 86400_000;
    const dated = creatives.filter((c) => c.lastShown);
    for (const c of creatives) if (c.format) out.formats[c.format] = (out.formats[c.format] ?? 0) + 1;

    if (dated.length) {
        const active = dated.filter((c) => Date.parse(c.lastShown) >= cutoff);
        out.activeCreativesInWindow = active.length;
        out.isRunningAds = active.length > 0;
        out.activityBasis = 'last_shown_date';
        const lastShown = Math.max(...dated.map((c) => Date.parse(c.lastShown)));
        const firstShown = Math.min(...dated.map((c) => Date.parse(c.firstShown ?? c.lastShown)));
        out.lastShownDate = new Date(lastShown).toISOString();
        out.firstShownDate = new Date(firstShown).toISOString();
        out.daysSinceLastShown = Math.max(0, Math.floor((now - lastShown) / 86400_000));
    } else {
        // No parseable dates (response format changed?): treat listed creatives as a
        // lower-confidence signal of activity and say so in activityBasis.
        out.activeCreativesInWindow = creatives.length;
        out.isRunningAds = true;
        out.activityBasis = 'creatives_listed_without_dates';
    }

    out.sampleAds = [...creatives]
        .sort((a, b) => Date.parse(b.lastShown ?? 0) - Date.parse(a.lastShown ?? 0))
        .slice(0, maxSampleAds)
        .map(({ creativeId, advertiserName, format, firstShown, lastShown, url }) => ({
            creativeId, advertiserName, format, firstShown, lastShown, url,
        }));
    return out;
}
