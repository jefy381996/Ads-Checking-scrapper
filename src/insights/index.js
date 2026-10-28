// Combines platform results into "ad intelligence": per-ad strength, account
// activity, EU transparency and modelled spend. Pure functions only.

import { summarizeEuTransparency } from '../platforms/meta-api.js';
import { combineEstimates, estimateLinkedInSpend, estimateMetaSpend } from './spend.js';
import { analyzeAdStrength } from './strength.js';

const AD_LIBRARY = 'https://www.facebook.com/ads/library/';

/** Joins ads seen on the Ad Library page with ads from the official API (EU reach). */
export function mergeMetaAds(pageAds = [], apiAds = [], { pageId, pageName } = {}) {
    const byId = new Map(pageAds.map((a) => [a.adArchiveId, { ...a }]));
    for (const api of apiAds) {
        const existing = byId.get(api.adArchiveId);
        if (existing) {
            existing.euTotalReach = api.euTotalReach ?? existing.euTotalReach ?? null;
            existing.euCountryReach = api.euCountryReach;
            existing.startDate ??= api.startDate;
            continue;
        }
        byId.set(api.adArchiveId, {
            adArchiveId: api.adArchiveId,
            pageId: api.pageId ?? pageId ?? null,
            pageName: api.pageName ?? pageName ?? null,
            startDate: api.startDate ? new Date(api.startDate).toISOString() : null,
            publisherPlatforms: api.publisherPlatforms.map((p) => String(p).toUpperCase()),
            displayFormat: null,
            title: api.linkTitle,
            body: api.body,
            ctaText: null,
            linkUrl: null,
            imageUrl: null,
            collationCount: null,
            euTotalReach: api.euTotalReach,
            euCountryReach: api.euCountryReach,
            adLibraryUrl: `${AD_LIBRARY}?id=${api.adArchiveId}`,
        });
    }
    return [...byId.values()];
}

export function buildInsights({ meta, metaApi, linkedin, windowDays, maxSampleAds, assumptions, now = Date.now() }) {
    const out = { meta: meta ? { ...meta } : null, linkedin: linkedin ? { ...linkedin } : null, summary: null };
    const summary = {
        accountActivity: null,
        daysSinceLastNewAd: null,
        topAdStrength: null,
        provenAds: 0,
        promisingAds: 0,
        adsScored: 0,
        euReach: null,
        estimatedMonthlySpendEur: null,
    };

    let metaSpend = null;
    if (out.meta?.checked && !out.meta.error) {
        const apiAds = metaApi?.ads ?? [];
        const ads = mergeMetaAds(out.meta.analyzedAds ?? [], apiAds, { pageId: out.meta.pageId, pageName: out.meta.pageName });
        if (ads.length) {
            const strength = analyzeAdStrength(ads, { windowDays, now });
            Object.assign(summary, {
                accountActivity: strength.summary.accountActivity,
                daysSinceLastNewAd: strength.summary.daysSinceLastNewAd,
                topAdStrength: strength.summary.topAdStrength,
                provenAds: strength.summary.provenAds,
                promisingAds: strength.summary.promisingAds,
                adsScored: strength.summary.adsScored,
            });
            out.meta.adStrength = strength.summary;
            out.meta.sampleAds = strength.scored.slice(0, maxSampleAds).map(({ ad, strength: s }) => ({
                adArchiveId: ad.adArchiveId,
                startDate: ad.startDate,
                daysRunning: s.daysRunning,
                copies: s.copies,
                strength: s.score,
                strengthLabel: s.label,
                strengthReasons: s.reasons,
                euReach: ad.euTotalReach ?? null,
                publisherPlatforms: ad.publisherPlatforms,
                displayFormat: ad.displayFormat ?? null,
                title: ad.title ?? null,
                body: ad.body ?? null,
                ctaText: ad.ctaText ?? null,
                linkUrl: ad.linkUrl ?? null,
                imageUrl: ad.imageUrl ?? null,
                adLibraryUrl: ad.adLibraryUrl,
            }));

            const source = apiAds.length ? 'meta_ad_library_api' : (ads.some((a) => a.euTotalReach) ? 'ad_library_page' : null);
            const eu = summarizeEuTransparency(apiAds.length ? apiAds : ads, { source, pageName: out.meta.pageName });
            if (metaApi?.error) eu.error = metaApi.error;
            if (!source && !metaApi?.error) {
                eu.note = metaApi?.attempted
                    ? 'None of the live ads reached the EU, so Meta publishes no reach data for them.'
                    : 'Add a Meta access token (input "Meta Ad Library API token") to get EU reach and spend estimates.';
            }
            out.meta.euTransparency = eu;
            summary.euReach = eu.totalEuReach;

            metaSpend = estimateMetaSpend(ads, {
                activeAdsCount: Math.max(out.meta.activeAdsCount ?? 0, apiAds.length),
                assumptions,
                now,
            });
            out.meta.spendEstimate = metaSpend;
        }
    }

    let linkedinSpend = null;
    if (out.linkedin?.checked && !out.linkedin.error && out.linkedin.adDetails?.length) {
        linkedinSpend = estimateLinkedInSpend(out.linkedin.adDetails, {
            activeAdsCount: out.linkedin.adsFound,
            assumptions,
            now,
        });
        out.linkedin.spendEstimate = linkedinSpend;
    }

    summary.estimatedMonthlySpendEur = combineEstimates([metaSpend, linkedinSpend]);
    out.summary = summary;
    return out;
}
