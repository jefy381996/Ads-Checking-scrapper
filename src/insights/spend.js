// Modelled ad spend for EU-delivered ads.
//
// Commercial ad spend is not public anywhere. Under the EU Digital Services Act,
// platforms disclose reach (Meta) or impression bands (LinkedIn) for ads shown
// in the EU, so a spend RANGE can be modelled:
//
//   spend ≈ reach × frequency × CPM / 1000          (Meta)
//   spend ≈ impressions × CPM / 1000                 (LinkedIn)
//
// Every input is a range and the output is a range, rounded to two significant
// figures so it never looks more precise than it is. The defaults are broad
// market benchmarks, not measurements. Agencies that know their real CPMs can
// override them through the `cpmAssumptionsEur` input.

const DAY = 86400_000;

// Meta CPM benchmarks in EUR by market tier (approximate public ranges).
const META_CPM_TIERS = {
    tier1: { range: [5, 12], countries: ['DE', 'FR', 'NL', 'BE', 'LU', 'AT', 'IE', 'DK', 'SE', 'FI'] },
    tier2: { range: [3, 8], countries: ['IT', 'ES', 'PT', 'MT', 'CY', 'SI', 'EE', 'LV', 'LT', 'CZ', 'SK', 'GR'] },
    tier3: { range: [1.5, 5], countries: ['PL', 'HU', 'RO', 'BG', 'HR'] },
};
export const DEFAULT_ASSUMPTIONS = {
    metaCpmEur: [3, 11], // used when the country mix is unknown
    metaFrequency: [1.4, 2.6], // average impressions per reached person over an ad's life
    linkedinCpmEur: [25, 70],
};

export const EU_COUNTRIES = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];

export function resolveAssumptions(overrides = {}) {
    const pair = (v, fallback) => (Array.isArray(v) && v.length === 2 && v.every((x) => Number.isFinite(Number(x)) && Number(x) > 0)
        ? [Math.min(Number(v[0]), Number(v[1])), Math.max(Number(v[0]), Number(v[1]))]
        : fallback);
    return {
        metaCpmEur: pair(overrides?.meta, null), // null = country-weighted tiers
        metaFrequency: pair(overrides?.frequency, DEFAULT_ASSUMPTIONS.metaFrequency),
        linkedinCpmEur: pair(overrides?.linkedin, DEFAULT_ASSUMPTIONS.linkedinCpmEur),
    };
}

export function metaCpmForCountry(country) {
    for (const tier of Object.values(META_CPM_TIERS)) if (tier.countries.includes(country)) return tier.range;
    return DEFAULT_ASSUMPTIONS.metaCpmEur;
}

/** CPM range weighted by where the reach happened, e.g. 70% DE + 30% PL. */
export function weightedMetaCpm(countryReach) {
    const total = (countryReach ?? []).reduce((s, c) => s + (c.reach ?? 0), 0);
    if (!total) return DEFAULT_ASSUMPTIONS.metaCpmEur;
    let low = 0;
    let high = 0;
    for (const c of countryReach) {
        const [l, h] = metaCpmForCountry(c.country);
        low += (l * c.reach) / total;
        high += (h * c.reach) / total;
    }
    return [low, high];
}

export function roundSig(n, digits = 2) {
    if (!Number.isFinite(n) || n === 0) return 0;
    const p = 10 ** (Math.floor(Math.log10(Math.abs(n))) - digits + 1);
    return Math.round(n / p) * p;
}

function monthlyFactor(days) {
    // Run-rate per 30 days. Very young ads are floored at 14 days so a launch
    // burst is not extrapolated into an absurd monthly figure.
    return 30.4 / Math.max(14, days ?? 30.4);
}

/**
 * Meta: `ads` have { euTotalReach, startDate, euCountryReach? }.
 * `activeAdsCount` is the advertiser's total live ads (for extrapolation).
 */
export function estimateMetaSpend(ads, { activeAdsCount, assumptions, now = Date.now() }) {
    const withReach = ads.filter((a) => Number.isFinite(a.euTotalReach) && a.euTotalReach > 0);
    if (!withReach.length) return null;
    const [fLow, fHigh] = assumptions.metaFrequency;
    let lifeLow = 0;
    let lifeHigh = 0;
    let monthLow = 0;
    let monthHigh = 0;
    for (const ad of withReach) {
        const [cLow, cHigh] = assumptions.metaCpmEur ?? weightedMetaCpm(ad.euCountryReach);
        const low = (ad.euTotalReach * fLow * cLow) / 1000;
        const high = (ad.euTotalReach * fHigh * cHigh) / 1000;
        const start = Date.parse(ad.startDate);
        const days = Number.isFinite(start) ? (now - start) / DAY : null;
        lifeLow += low;
        lifeHigh += high;
        monthLow += low * monthlyFactor(days);
        monthHigh += high * monthlyFactor(days);
    }
    return finish({
        platform: 'meta',
        basis: 'eu_reach',
        method: 'EU reach × frequency × CPM benchmark',
        adsWithData: withReach.length,
        activeAdsCount,
        lifeLow, lifeHigh, monthLow, monthHigh,
        assumptions: {
            frequency: assumptions.metaFrequency,
            cpmEur: assumptions.metaCpmEur
                ?? (withReach.some((a) => a.euCountryReach?.length)
                    ? 'weighted by EU country tier (DE/FR/NL ≈ €5-12, ES/IT ≈ €3-8, PL/RO ≈ €1.5-5)'
                    : DEFAULT_ASSUMPTIONS.metaCpmEur),
        },
    });
}

/** LinkedIn: `ads` have { impressions: { low, high }, ranFrom, ranTo }. */
export function estimateLinkedInSpend(ads, { activeAdsCount, assumptions, now = Date.now() }) {
    const withData = ads.filter((a) => Number.isFinite(a.impressions?.high) && a.impressions.high > 0);
    if (!withData.length) return null;
    const [cLow, cHigh] = assumptions.linkedinCpmEur;
    let lifeLow = 0;
    let lifeHigh = 0;
    let monthLow = 0;
    let monthHigh = 0;
    for (const ad of withData) {
        const low = ((ad.impressions.low ?? 0) * cLow) / 1000;
        const high = (ad.impressions.high * cHigh) / 1000;
        const from = Date.parse(ad.ranFrom);
        const to = ad.ranTo ? Date.parse(ad.ranTo) : now;
        const days = Number.isFinite(from) ? ((Number.isFinite(to) ? to : now) - from) / DAY : null;
        lifeLow += low;
        lifeHigh += high;
        monthLow += low * monthlyFactor(days);
        monthHigh += high * monthlyFactor(days);
    }
    return finish({
        platform: 'linkedin',
        basis: 'linkedin_impressions',
        method: 'Impression range × CPM benchmark',
        adsWithData: withData.length,
        activeAdsCount,
        lifeLow, lifeHigh, monthLow, monthHigh,
        assumptions: { cpmEur: assumptions.linkedinCpmEur },
    });
}

function finish({ platform, basis, method, adsWithData, activeAdsCount, lifeLow, lifeHigh, monthLow, monthHigh, assumptions }) {
    const total = Math.max(activeAdsCount ?? adsWithData, adsWithData);
    const coverage = total ? adsWithData / total : 1;
    const scale = coverage > 0 && coverage < 1 ? 1 / coverage : 1;
    return {
        platform,
        currency: 'EUR',
        scope: 'Ads delivered in the EU only',
        basis,
        method,
        lifetime: { low: roundSig(lifeLow), high: roundSig(lifeHigh) },
        monthly: { low: roundSig(monthLow), high: roundSig(monthHigh) },
        // Extrapolates the ads with data to all live ads; looser than `monthly`.
        monthlyExtrapolated: scale > 1 ? { low: roundSig(monthLow * scale), high: roundSig(monthHigh * scale) } : null,
        adsWithData,
        activeAds: total,
        coverage: Math.round(coverage * 100) / 100,
        assumptions,
        confidence: coverage >= 0.5 ? 'low' : 'very_low',
        disclaimer: 'Modelled from public reach/impression data and benchmark CPMs. Not the advertiser\'s actual spend.',
    };
}

export function spendTier(monthly) {
    if (!monthly) return null;
    const mid = Math.sqrt(Math.max(1, monthly.low) * Math.max(1, monthly.high));
    if (mid < 500) return 'micro';
    if (mid < 2_500) return 'small';
    if (mid < 10_000) return 'medium';
    if (mid < 50_000) return 'large';
    return 'very_large';
}

/** Combines platform estimates into one monthly EUR range for the business. */
export function combineEstimates(estimates) {
    const list = estimates.filter(Boolean);
    if (!list.length) return null;
    const pick = (e) => e.monthlyExtrapolated ?? e.monthly;
    const low = list.reduce((s, e) => s + pick(e).low, 0);
    const high = list.reduce((s, e) => s + pick(e).high, 0);
    const monthly = { low: roundSig(low), high: roundSig(high) };
    return {
        currency: 'EUR',
        low: monthly.low,
        high: monthly.high,
        tier: spendTier(monthly),
        platforms: list.map((e) => e.platform),
        scope: 'EU-delivered ads only',
        confidence: list.every((e) => e.confidence === 'low') ? 'low' : 'very_low',
        disclaimer: 'Modelled estimate, not actual spend. See the platform sections for assumptions.',
    };
}
