// Official Meta Ad Library API (graph.facebook.com/<version>/ads_archive).
//
// The documented source for EU transparency data on commercial ads:
// eu_total_reach, age_country_gender_reach_breakdown, targeting and
// beneficiary/payer. It needs the user's own access token, which requires
// identity confirmation at facebook.com/ID and Ad Library API access. Without a
// token the Actor still works; it just has no EU reach data for Meta.

import { errorMessage } from '../utils/http.js';
import { nameSimilarity } from '../utils/text.js';
import { EU_COUNTRIES } from '../insights/spend.js';

const GRAPH_VERSION = 'v25.0';
const FIELDS = [
    'id', 'page_id', 'page_name', 'ad_delivery_start_time', 'ad_delivery_stop_time', 'ad_snapshot_url',
    'publisher_platforms', 'languages', 'ad_creative_bodies', 'ad_creative_link_titles', 'ad_creative_link_captions',
    'eu_total_reach', 'age_country_gender_reach_breakdown', 'target_ages', 'target_gender', 'target_locations',
    'beneficiary_payers',
].join(',');

export function emptyEuTransparency() {
    return {
        source: null,
        adsWithEuReach: 0,
        totalEuReach: null,
        topCountries: [],
        audience: null,
        targeting: null,
        payers: [],
        beneficiaries: [],
        error: null,
    };
}

export function reachedCountriesParam(country) {
    // Commercial ads are only returned when they reached the EU; "ALL" covers every country.
    return JSON.stringify(country && EU_COUNTRIES.includes(country) ? [country] : ['ALL']);
}

/** Fetches live ads of one page with EU transparency fields. Returns parsed ads. */
export async function fetchMetaApiAds({ accessToken, pageId, country, maxAds = 300, fetchImpl = fetch }) {
    const params = new URLSearchParams({
        access_token: accessToken,
        ad_type: 'ALL',
        ad_active_status: 'ACTIVE',
        ad_reached_countries: reachedCountriesParam(country),
        search_page_ids: JSON.stringify([String(pageId)]),
        fields: FIELDS,
        limit: String(Math.min(300, maxAds)),
    });
    let url = `https://graph.facebook.com/${GRAPH_VERSION}/ads_archive?${params}`;
    const ads = [];
    for (let page = 0; url && ads.length < maxAds && page < 10; page++) {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
        const data = await res.json().catch(() => ({}));
        if (data.error) throw new Error(explainGraphError(data.error));
        if (!res.ok) throw new Error(`Meta Ad Library API returned HTTP ${res.status}`);
        for (const raw of data.data ?? []) ads.push(parseApiAd(raw));
        url = data.paging?.next ?? null;
    }
    return ads.slice(0, maxAds);
}

export function explainGraphError(error) {
    const code = error.code;
    if (code === 190) return 'Meta access token is invalid or expired. Generate a new one.';
    if (code === 10 || code === 200) {
        return 'This Meta token has no Ad Library API access. Confirm your identity at facebook.com/ID and accept the Ad Library API terms.';
    }
    if (code === 4 || code === 17 || code === 613) return 'Meta Ad Library API rate limit reached. Try again later or with fewer businesses.';
    return `Meta Ad Library API error ${code ?? ''}: ${error.message ?? 'unknown'}`.trim();
}

export function parseApiAd(raw) {
    const countryReach = [];
    const ageTotals = {};
    const gender = { male: 0, female: 0, unknown: 0 };
    for (const c of Array.isArray(raw.age_country_gender_reach_breakdown) ? raw.age_country_gender_reach_breakdown : []) {
        let reach = 0;
        for (const b of Array.isArray(c.age_gender_breakdowns) ? c.age_gender_breakdowns : []) {
            const m = Number(b.male) || 0;
            const f = Number(b.female) || 0;
            const u = Number(b.unknown) || 0;
            reach += m + f + u;
            gender.male += m;
            gender.female += f;
            gender.unknown += u;
            if (b.age_range && String(b.age_range).toLowerCase() !== 'unknown') {
                ageTotals[b.age_range] = (ageTotals[b.age_range] ?? 0) + m + f + u;
            }
        }
        if (c.country) countryReach.push({ country: c.country, reach });
    }
    const reach = Number(raw.eu_total_reach);
    return {
        adArchiveId: String(raw.id),
        pageId: raw.page_id ? String(raw.page_id) : null,
        pageName: raw.page_name ?? null,
        startDate: raw.ad_delivery_start_time ?? null,
        stopDate: raw.ad_delivery_stop_time ?? null,
        publisherPlatforms: Array.isArray(raw.publisher_platforms) ? raw.publisher_platforms : [],
        body: Array.isArray(raw.ad_creative_bodies) ? raw.ad_creative_bodies[0] ?? null : null,
        linkTitle: Array.isArray(raw.ad_creative_link_titles) ? raw.ad_creative_link_titles[0] ?? null : null,
        snapshotUrl: raw.ad_snapshot_url ?? null,
        euTotalReach: Number.isFinite(reach) && reach > 0 ? reach : null,
        euCountryReach: countryReach,
        ageTotals,
        gender,
        targetAges: Array.isArray(raw.target_ages) ? raw.target_ages : null,
        targetGender: raw.target_gender ?? null,
        targetLocations: Array.isArray(raw.target_locations)
            ? raw.target_locations.filter((l) => !l.excluded).map((l) => l.name).filter(Boolean)
            : null,
        beneficiaryPayers: Array.isArray(raw.beneficiary_payers) ? raw.beneficiary_payers : [],
    };
}

/** Aggregates per-ad EU data into the business-level `euTransparency` block. */
export function summarizeEuTransparency(ads, { source, pageName }) {
    const out = emptyEuTransparency();
    out.source = source;
    const withReach = ads.filter((a) => Number.isFinite(a.euTotalReach));
    out.adsWithEuReach = withReach.length;
    out.totalEuReach = withReach.length ? withReach.reduce((s, a) => s + a.euTotalReach, 0) : null;

    const byCountry = {};
    const ages = {};
    const gender = { male: 0, female: 0, unknown: 0 };
    const targetAges = new Set();
    const locations = {};
    const payers = new Set();
    const beneficiaries = new Set();
    for (const a of ads) {
        for (const c of a.euCountryReach ?? []) byCountry[c.country] = (byCountry[c.country] ?? 0) + c.reach;
        for (const [k, v] of Object.entries(a.ageTotals ?? {})) ages[k] = (ages[k] ?? 0) + v;
        for (const k of Object.keys(gender)) gender[k] += a.gender?.[k] ?? 0;
        for (const t of a.targetAges ?? []) targetAges.add(t);
        for (const l of a.targetLocations ?? []) locations[l] = (locations[l] ?? 0) + 1;
        for (const bp of a.beneficiaryPayers ?? []) {
            if (bp.payer) payers.add(bp.payer);
            if (bp.beneficiary) beneficiaries.add(bp.beneficiary);
        }
    }
    const countryTotal = Object.values(byCountry).reduce((s, v) => s + v, 0);
    out.topCountries = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([country, reach]) => ({ country, reach, share: countryTotal ? Math.round((reach / countryTotal) * 100) / 100 : null }));
    const genderTotal = gender.male + gender.female + gender.unknown;
    if (genderTotal) {
        const ageTotal = Object.values(ages).reduce((s, v) => s + v, 0);
        out.audience = {
            genderSplit: {
                male: Math.round((gender.male / genderTotal) * 100) / 100,
                female: Math.round((gender.female / genderTotal) * 100) / 100,
                unknown: Math.round((gender.unknown / genderTotal) * 100) / 100,
            },
            topAgeRanges: Object.entries(ages).sort((a, b) => b[1] - a[1]).slice(0, 3)
                .map(([range, reach]) => ({ range, share: ageTotal ? Math.round((reach / ageTotal) * 100) / 100 : null })),
        };
    }
    if (targetAges.size || Object.keys(locations).length) {
        out.targeting = {
            ageRanges: [...targetAges].slice(0, 10),
            topLocations: Object.entries(locations).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name]) => name),
        };
    }
    out.payers = [...payers].slice(0, 5);
    out.beneficiaries = [...beneficiaries].slice(0, 5);
    // Payer clearly different from the brand → usually an agency or reseller paying.
    out.likelyAgencyPayer = out.payers.find((p) => [pageName, ...out.beneficiaries].filter(Boolean)
        .every((n) => nameSimilarity(p, n) < 0.6)) ?? null;
    return out;
}

export async function safeFetchMetaApiAds(opts) {
    try {
        return { ads: await fetchMetaApiAds(opts), error: null };
    } catch (err) {
        return { ads: [], error: errorMessage(err) };
    }
}
