// Turns raw platform results into decisions: a verdict, a 0-100 advertiser
// score, and opportunity signals that sales and agency teams act on.

import { nameSimilarity } from './utils/text.js';

const CONFIDENCE_RANK = { low: 1, medium: 2, high: 3 };
const PLATFORM_LABEL = { meta: 'Facebook/Instagram', google: 'Google', linkedin: 'LinkedIn' };

export function activeCount(platform, result) {
    if (!result?.isRunningAds) return 0;
    if (platform === 'meta') return result.activeAdsCount ?? 0;
    if (platform === 'google') return result.activeCreativesInWindow ?? 0;
    if (platform === 'linkedin') return result.adsFound ?? 0;
    return 0;
}

export function evaluate({ meta, google, linkedin, website, insights = null }, { windowDays }) {
    const platforms = { meta, google, linkedin };
    const checked = Object.entries(platforms).filter(([, r]) => r?.checked);
    const active = checked.filter(([, r]) => r.isRunningAds).map(([k]) => k);
    const failed = checked.filter(([, r]) => r.error).map(([k]) => k);
    const totalActiveAds = active.reduce((sum, k) => sum + activeCount(k, platforms[k]), 0);
    const pixels = new Set(website?.adPixels ?? []);
    const hasAdPixels = pixels.size > 0;

    let verdict;
    if (active.length) verdict = 'RUNNING_ADS';
    else if (!checked.length) verdict = hasAdPixels ? 'AD_PIXELS_ONLY' : 'NOT_CHECKED';
    else if (failed.length === checked.length) verdict = 'INCONCLUSIVE';
    else if (hasAdPixels) verdict = 'AD_PIXELS_ONLY';
    else verdict = 'NOT_RUNNING_ADS';

    // Confidence: best evidence for a positive, weakest link for a negative.
    let confidence;
    if (active.length) {
        confidence = maxConfidence(active.map((k) => platforms[k].matchConfidence));
    } else {
        const ok = checked.filter(([, r]) => !r.error).map(([, r]) => r.matchConfidence);
        confidence = failed.length ? 'low' : minConfidence(ok);
    }

    const score = advertiserScore({ meta, google, linkedin, pixels, insights });
    const signals = opportunitySignals({ meta, google, linkedin, website, pixels, windowDays, insights });
    return {
        isRunningAds: active.length > 0,
        verdict,
        confidence: confidence ?? 'low',
        activePlatforms: active,
        failedPlatforms: failed,
        totalActiveAds,
        advertiserScore: score,
        adIntensity: intensity(totalActiveAds, active.length),
        signals,
        signalCodes: signals.map((s) => s.code),
        insights,
    };
}

function similarName(a, b) {
    return nameSimilarity(a, b) >= 0.6;
}

function maxConfidence(list) {
    return list.filter(Boolean).sort((a, b) => CONFIDENCE_RANK[b] - CONFIDENCE_RANK[a])[0] ?? null;
}

function minConfidence(list) {
    return list.filter(Boolean).sort((a, b) => CONFIDENCE_RANK[a] - CONFIDENCE_RANK[b])[0] ?? null;
}

function intensity(totalAds, platformCount) {
    if (!totalAds && !platformCount) return 'none';
    if (totalAds >= 50 || (platformCount >= 2 && totalAds >= 15)) return 'high';
    if (totalAds >= 8 || platformCount >= 2) return 'medium';
    return 'low';
}

/**
 * 0-100: how likely this business is to be spending on paid media right now.
 * Live ads dominate. Pixels are weaker evidence: tracking without live ads
 * usually means a past or paused advertiser.
 */
export function advertiserScore({ meta, google, linkedin, pixels, insights = null }) {
    let score = 0;
    const logBonus = (n, max) => Math.min(max, Math.round(Math.log10(1 + n) * (max / 2)));
    if (meta?.isRunningAds) score += 35 + logBonus(meta.activeAdsCount ?? 0, 10);
    if (google?.isRunningAds) score += 30 + logBonus(google.activeCreativesInWindow ?? 0, 10);
    if (linkedin?.isRunningAds) score += 15 + logBonus(linkedin.adsFound ?? 0, 5);
    if ((meta?.longestRunningAdDays ?? 0) >= 90) score += 5;

    const running = Boolean(meta?.isRunningAds || google?.isRunningAds || linkedin?.isRunningAds);
    let pixelPoints = 0;
    for (const p of pixels) {
        const major = p === 'metaPixel' || p === 'googleAds';
        pixelPoints += running ? 2 : (major ? 12 : 5);
    }
    score += Math.min(running ? 10 : 30, pixelPoints);
    // Modelled EU spend backs up a "big spender" reading (only when it exists).
    if (['medium', 'large', 'very_large'].includes(insights?.estimatedMonthlySpendEur?.tier)) score += 5;
    return Math.max(0, Math.min(100, score));
}

export function opportunitySignals({ meta, google, linkedin, website, pixels, windowDays, insights = null }) {
    const signals = [];
    const add = (code, title, detail) => signals.push({ code, title, detail });
    const scanned = Boolean(website?.reachable);

    if (scanned && pixels.has('metaPixel') && meta?.checked && !meta.error && !meta.isRunningAds) {
        add('META_PIXEL_NO_ACTIVE_ADS', 'Meta Pixel installed, no live Meta ads',
            'Tracking is set up but nothing is running in the Meta Ad Library. Usually a paused or lapsed advertiser.');
    }
    if (scanned && pixels.has('googleAds') && google?.checked && !google.error && !google.isRunningAds) {
        add('GOOGLE_TAG_NO_ACTIVE_ADS', 'Google Ads tag installed, no recent Google ads',
            `A Google Ads conversion or remarketing tag is present, but no ads were shown in the last ${windowDays} days.`);
    }
    if (scanned && meta?.isRunningAds && !pixels.has('metaPixel')) {
        add('META_ADS_WITHOUT_PIXEL', 'Running Meta ads without a detectable Meta Pixel',
            'No Meta Pixel was found on the homepage or in its tag managers. Conversion tracking may be missing (or server-side only).');
    }
    if (scanned && google?.isRunningAds && !pixels.has('googleAds')) {
        add('GOOGLE_ADS_WITHOUT_CONVERSION_TAG', 'Running Google ads without a detectable Google Ads tag',
            'No AW- conversion or remarketing tag was found. Google may be optimizing without conversion data.');
    }
    const metaOn = Boolean(meta?.isRunningAds);
    const googleOn = Boolean(google?.isRunningAds);
    if (metaOn !== googleOn && meta?.checked && google?.checked && !meta.error && !google.error) {
        const on = metaOn ? 'Meta' : 'Google';
        const off = metaOn ? 'Google' : 'Meta';
        add('SINGLE_CHANNEL', `Advertising on ${on} only`, `Active on ${on} but not on ${off}: a cross-channel expansion opportunity.`);
    }
    const staticAccount = insights?.accountActivity === 'static';
    if (metaOn && staticAccount) {
        add('SET_AND_FORGET', 'Meta ads look unmanaged',
            `No new Meta ad launched in ${insights.daysSinceLastNewAd} days; the same creatives keep running. Old ads here may be neglected, not winners.`);
    } else if (metaOn && (meta.longestRunningAdDays ?? 0) >= 90) {
        add('LONG_RUNNING_CREATIVES', 'Ads running 90+ days',
            `The oldest live Meta ad has run for ${meta.longestRunningAdDays} days in an actively managed account: likely a winner, and possibly creative fatigue.`);
    }
    if (metaOn && (insights?.provenAds ?? 0) > 0) {
        add('WINNING_CREATIVES', 'Has proven ads',
            `${insights.provenAds} live Meta ad${insights.provenAds === 1 ? '' : 's'} score 70+ on ad strength (long-running, duplicated, wide placement${insights.euReach ? ', high EU reach' : ''}).`);
    }
    const payer = meta?.euTransparency?.likelyAgencyPayer
        ?? (linkedin?.adDetails ?? []).map((d) => d.paidBy).find((p) => p && insights?.businessName && !similarName(p, insights.businessName));
    if (payer) {
        add('AGENCY_MANAGED', 'Ads paid by a third party', `Ads are paid for by "${payer}", which is usually an agency or reseller.`);
    }
    const tier = insights?.estimatedMonthlySpendEur?.tier;
    if (tier === 'large' || tier === 'very_large') {
        const est = insights.estimatedMonthlySpendEur;
        add('BIG_EU_SPENDER', 'Large modelled EU budget',
            `Modelled EU spend of about €${est.low.toLocaleString('en-US')}-${est.high.toLocaleString('en-US')} per month (an estimate from public reach data).`);
    }
    if (metaOn && meta.activeAdsCount > 0 && meta.activeAdsCount <= 3) {
        add('LOW_CREATIVE_VOLUME', 'Very few live creatives',
            `Only ${meta.activeAdsCount} live Meta ad${meta.activeAdsCount === 1 ? '' : 's'}: limited creative testing.`);
    }
    if (metaOn && meta.adsAnalyzed >= 4 && meta.adsStartedInWindow >= Math.max(5, Math.ceil(meta.adsAnalyzed * 0.5))) {
        add('SCALING_NOW', 'Launching lots of new ads',
            `${meta.adsStartedInWindow} of the ${meta.adsAnalyzed} live Meta ads analyzed started in the last ${windowDays} days.`);
    }
    if (linkedin?.isRunningAds) {
        add('B2B_ADVERTISER', 'Advertising on LinkedIn', 'Runs LinkedIn ads, so it has a B2B marketing budget.');
    }
    if (website?.ecommercePlatform && website.ecommercePlatform !== 'WordPress') {
        add('ECOMMERCE_STORE', `${website.ecommercePlatform} store`, `The website runs on ${website.ecommercePlatform}.`);
    }
    const nothing = !metaOn && !googleOn && !linkedin?.isRunningAds;
    const allClean = [meta, google, linkedin].filter((r) => r?.checked).every((r) => !r.error);
    if (nothing && allClean && scanned && pixels.size === 0) {
        add('NO_ADS_NO_TRACKING', 'No ads and no ad tracking',
            'Not advertising and no ad pixels installed: a greenfield prospect, or not a paid-media buyer.');
    }
    return signals;
}

/** A short, factual first line for cold outreach, based on the strongest signal. */
export function outreachSnippet({ name, domain, evaluation, meta, google, linkedin }) {
    const who = name || domain || 'your brand';
    const site = domain || 'your site';
    const codes = new Set(evaluation.signalCodes);
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    if (codes.has('META_ADS_WITHOUT_PIXEL')) {
        return `Noticed ${who} has ${plural(meta.activeAdsCount, 'live Meta ad')}, but I couldn't find a Meta Pixel on ${site}. Is conversion tracking set up server-side?`;
    }
    if (codes.has('SET_AND_FORGET')) {
        return `Noticed ${who} hasn't launched a new Facebook/Instagram ad in ${evaluation.insights?.daysSinceLastNewAd ?? 90}+ days; the same creatives are still running. Is anyone actively testing new ones?`;
    }
    if (codes.has('META_PIXEL_NO_ACTIVE_ADS')) {
        return `Saw the Meta Pixel is still installed on ${site}, but ${who} has no live ads in the Meta Ad Library right now. Were Meta ads paused on purpose?`;
    }
    if (codes.has('GOOGLE_ADS_WITHOUT_CONVERSION_TAG')) {
        return `Noticed ${who} is running Google ads, but I couldn't spot a Google Ads conversion tag on ${site}. Are conversions tracked another way?`;
    }
    if (codes.has('SCALING_NOW')) {
        return `Looks like ${who} launched ${plural(meta.adsStartedInWindow, 'new Meta ad')} recently. Scaling up?`;
    }
    if (codes.has('LONG_RUNNING_CREATIVES')) {
        return `Your oldest live Meta ad has been running for ${meta.longestRunningAdDays} days, which usually means it's working. Are you testing new creative against it?`;
    }
    if (codes.has('SINGLE_CHANNEL')) {
        const on = meta?.isRunningAds ? 'Facebook/Instagram' : 'Google';
        const off = meta?.isRunningAds ? 'Google' : 'Facebook/Instagram';
        return `Saw ${who} is advertising on ${on} but not on ${off} right now. Is that a deliberate channel choice?`;
    }
    if (codes.has('GOOGLE_TAG_NO_ACTIVE_ADS')) {
        return `${site} still has a Google Ads tag installed, but I couldn't find recent Google ads from ${who}. Are campaigns paused?`;
    }
    if (evaluation.isRunningAds) {
        const where = evaluation.activePlatforms.map((p) => PLATFORM_LABEL[p]).join(' and ');
        return `Saw ${who} is currently running ads on ${where}.`;
    }
    if (evaluation.verdict === 'NOT_RUNNING_ADS') {
        const checked = Object.entries({ meta, google, linkedin })
            .filter(([, r]) => r?.checked && !r.error)
            .map(([k]) => PLATFORM_LABEL[k]);
        return `Couldn't find any live ads for ${who} on ${checked.join(', ')}. Is paid acquisition something you've tested?`;
    }
    return null;
}
