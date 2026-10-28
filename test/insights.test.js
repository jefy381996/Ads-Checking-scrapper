import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildInsights, mergeMetaAds } from '../src/insights/index.js';
import {
    combineEstimates, estimateLinkedInSpend, estimateMetaSpend, resolveAssumptions, roundSig, spendTier, weightedMetaCpm,
} from '../src/insights/spend.js';
import { accountActivity, analyzeAdStrength, scoreAd } from '../src/insights/strength.js';
import { buildSnapshot, diffSnapshots } from '../src/monitor.js';
import { fetchMetaApiAds, parseApiAd, reachedCountriesParam, summarizeEuTransparency } from '../src/platforms/meta-api.js';
import { parseLinkedInAdDetail } from '../src/platforms/linkedin.js';
import { evaluate, outreachSnippet } from '../src/scoring.js';

const NOW = Date.parse('2026-10-28T00:00:00Z');
const DAY = 86400_000;
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

test('account activity: active testing, steady, static', () => {
    const active = accountActivity([{ startDate: daysAgo(2) }, { startDate: daysAgo(5) }, { startDate: daysAgo(9) }, { startDate: daysAgo(200) }], { windowDays: 30, now: NOW });
    assert.equal(active.status, 'active_testing');
    const steady = accountActivity([{ startDate: daysAgo(40) }, { startDate: daysAgo(80) }], { windowDays: 30, now: NOW });
    assert.equal(steady.status, 'steady');
    const stat = accountActivity([{ startDate: daysAgo(120) }, { startDate: daysAgo(300) }], { windowDays: 30, now: NOW });
    assert.equal(stat.status, 'static');
    assert.equal(stat.daysSinceLastNewAd, 120);
    assert.equal(accountActivity([], { windowDays: 30, now: NOW }).status, 'unknown');
});

test('ad strength: long-running scaled ad is proven, but discounted in a static account', () => {
    const winner = { startDate: daysAgo(110), collationCount: 8, publisherPlatforms: ['FACEBOOK', 'INSTAGRAM', 'MESSENGER', 'AUDIENCE_NETWORK'] };
    const inActive = scoreAd(winner, { activity: 'active_testing', now: NOW });
    const inStatic = scoreAd(winner, { activity: 'static', now: NOW });
    assert.ok(inActive.score >= 70, `expected proven, got ${inActive.score}`);
    assert.equal(inActive.label, 'proven');
    assert.ok(inStatic.score < inActive.score);
    assert.ok(inStatic.reasons.some((r) => /launches no new ads/.test(r)));
    const fresh = scoreAd({ startDate: daysAgo(2), collationCount: 1, publisherPlatforms: ['FACEBOOK'] }, { activity: 'active_testing', now: NOW });
    assert.equal(fresh.label, 'unproven');
    assert.ok(fresh.reasons[0].includes('too new'));

    // EU reach percentile: the top-reach ad of the advertiser gains points.
    const reachValues = [1_000, 2_000, 3_000, 500_000];
    const top = scoreAd({ ...winner, euTotalReach: 500_000 }, { activity: 'active_testing', reachValues, now: NOW });
    const low = scoreAd({ ...winner, euTotalReach: 1_000 }, { activity: 'active_testing', reachValues, now: NOW });
    assert.ok(top.score > low.score);

    const { summary, scored } = analyzeAdStrength([winner, { startDate: daysAgo(3) }], { windowDays: 30, now: NOW });
    assert.equal(summary.adsScored, 2);
    assert.equal(scored[0].ad, winner);
});

test('spend model: Meta reach x frequency x country CPM, rounded, with extrapolation', () => {
    const assumptions = resolveAssumptions();
    const ads = [{ euTotalReach: 100_000, startDate: daysAgo(61), euCountryReach: [{ country: 'DE', reach: 100_000 }] }, { startDate: daysAgo(5) }];
    const est = estimateMetaSpend(ads, { activeAdsCount: 2, assumptions, now: NOW });
    // lifetime: 100k*1.4*5/1000 = 700 ; 100k*2.6*12/1000 = 3120 -> 3100
    assert.deepEqual(est.lifetime, { low: 700, high: 3100 });
    // monthly run-rate: x 30.4/61
    assert.deepEqual(est.monthly, { low: 350, high: 1600 });
    assert.deepEqual(est.monthlyExtrapolated, { low: 700, high: 3100 });
    assert.equal(est.coverage, 0.5);
    assert.equal(est.currency, 'EUR');
    assert.match(est.assumptions.cpmEur, /weighted by EU country/);
    const noCountry = estimateMetaSpend([{ euTotalReach: 1000, startDate: daysAgo(30) }], { activeAdsCount: 1, assumptions, now: NOW });
    assert.deepEqual(noCountry.assumptions.cpmEur, [3, 11]);
    assert.match(est.disclaimer, /Not the advertiser's actual spend/);

    const custom = estimateMetaSpend([{ euTotalReach: 100_000, startDate: daysAgo(30.4) }], {
        activeAdsCount: 1, assumptions: resolveAssumptions({ meta: [10, 10], frequency: [2, 2] }), now: NOW,
    });
    assert.deepEqual(custom.lifetime, { low: 2000, high: 2000 });
    assert.equal(custom.monthlyExtrapolated, null);
    assert.equal(estimateMetaSpend([{ startDate: daysAgo(10) }], { activeAdsCount: 1, assumptions, now: NOW }), null);

    const [l, h] = weightedMetaCpm([{ country: 'DE', reach: 50 }, { country: 'PL', reach: 50 }]);
    assert.equal(l, 3.25);
    assert.equal(h, 8.5);
});

test('spend model: LinkedIn impressions x CPM; tiers and combination', () => {
    const est = estimateLinkedInSpend([{ impressions: { low: 10_000, high: 50_000 }, ranFrom: '2026-09-28', ranTo: '2026-10-28' }], {
        activeAdsCount: 1, assumptions: resolveAssumptions(), now: NOW,
    });
    assert.deepEqual(est.lifetime, { low: 250, high: 3500 });
    assert.deepEqual(est.monthly, { low: 250, high: 3500 });
    assert.equal(roundSig(12_345), 12_000);
    assert.equal(roundSig(0.0456), 0.046);
    assert.equal(spendTier({ low: 400, high: 900 }), 'small');
    assert.equal(spendTier({ low: 20_000, high: 90_000 }), 'large');
    const combined = combineEstimates([est, null]);
    assert.equal(combined.low, 250);
    assert.deepEqual(combined.platforms, ['linkedin']);
    assert.equal(combineEstimates([null]), null);
});

test('Meta API: parse documented EU fields and summarize; detect agency payer', () => {
    const raw = {
        id: '111', page_id: '9', page_name: 'Acme', ad_delivery_start_time: '2026-08-01',
        publisher_platforms: ['facebook', 'instagram'], ad_creative_bodies: ['Buy now'],
        eu_total_reach: 120000,
        age_country_gender_reach_breakdown: [
            { country: 'DE', age_gender_breakdowns: [{ age_range: '25-34', male: 30000, female: 40000, unknown: 0 }, { age_range: 'Unknown', male: 0, female: 0, unknown: 1000 }] },
            { country: 'AT', age_gender_breakdowns: [{ age_range: '35-44', male: 20000, female: 29000, unknown: 0 }] },
        ],
        target_ages: ['18', '65+'],
        target_locations: [{ name: 'Germany', excluded: false }, { name: 'Bavaria', excluded: true }],
        beneficiary_payers: [{ payer: 'Growthly Media GmbH', beneficiary: 'Acme', current: true }],
    };
    const ad = parseApiAd(raw);
    assert.equal(ad.euTotalReach, 120000);
    assert.deepEqual(ad.euCountryReach, [{ country: 'DE', reach: 71000 }, { country: 'AT', reach: 49000 }]);
    assert.deepEqual(ad.targetLocations, ['Germany']);
    const eu = summarizeEuTransparency([ad], { source: 'meta_ad_library_api', pageName: 'Acme' });
    assert.equal(eu.totalEuReach, 120000);
    assert.equal(eu.topCountries[0].country, 'DE');
    assert.equal(eu.topCountries[0].share, 0.59);
    assert.equal(eu.audience.topAgeRanges[0].range, '25-34');
    assert.equal(eu.likelyAgencyPayer, 'Growthly Media GmbH');
    const self = summarizeEuTransparency([parseApiAd({ ...raw, beneficiary_payers: [{ payer: 'Acme GmbH', beneficiary: 'Acme' }] })], { source: 'x', pageName: 'Acme' });
    assert.equal(self.likelyAgencyPayer, null);
    assert.equal(reachedCountriesParam('DE'), '["DE"]');
    assert.equal(reachedCountriesParam('US'), '["ALL"]');
});

test('Meta API client: paging and friendly errors', async () => {
    const pages = {
        first: { data: [{ id: '1', eu_total_reach: 10 }], paging: { next: 'https://graph.facebook.com/next' } },
        next: { data: [{ id: '2' }] },
    };
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        const body = url.includes('/next') ? pages.next : pages.first;
        return { ok: true, status: 200, json: async () => body };
    };
    const ads = await fetchMetaApiAds({ accessToken: 't', pageId: '9', country: 'ALL', fetchImpl });
    assert.deepEqual(ads.map((a) => a.adArchiveId), ['1', '2']);
    assert.match(calls[0], /ad_type=ALL/);
    assert.match(calls[0], /search_page_ids=%5B%229%22%5D/);
    assert.match(calls[0], /eu_total_reach/);

    const bad = async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 190, message: 'expired' } }) });
    await assert.rejects(fetchMetaApiAds({ accessToken: 't', pageId: '9', fetchImpl: bad }), /invalid or expired/);
    const noAccess = async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 10, message: 'no permission' } }) });
    await assert.rejects(fetchMetaApiAds({ accessToken: 't', pageId: '9', fetchImpl: noAccess }), /facebook\.com\/ID/);
});

test('buildInsights merges page + API ads, ranks samples by strength, models spend', () => {
    const pageAds = [
        { adArchiveId: 'a', startDate: daysAgo(3), collationCount: 1, publisherPlatforms: ['FACEBOOK'], adLibraryUrl: 'u-a' },
        { adArchiveId: 'b', startDate: daysAgo(100), collationCount: 6, publisherPlatforms: ['FACEBOOK', 'INSTAGRAM', 'MESSENGER'], adLibraryUrl: 'u-b' },
    ];
    const apiAds = [
        parseApiAd({ id: 'b', ad_delivery_start_time: '2026-07-20', eu_total_reach: 300000, age_country_gender_reach_breakdown: [{ country: 'FR', age_gender_breakdowns: [{ age_range: '25-34', male: 150000, female: 150000 }] }] }),
        parseApiAd({ id: 'c', ad_delivery_start_time: '2026-10-01', publisher_platforms: ['facebook'], eu_total_reach: 20000 }),
    ];
    const merged = mergeMetaAds(pageAds, apiAds);
    assert.equal(merged.length, 3);
    assert.equal(merged.find((a) => a.adArchiveId === 'b').euTotalReach, 300000);

    const meta = { checked: true, error: null, isRunningAds: true, activeAdsCount: 3, adsAnalyzed: 2, pageId: '9', pageName: 'Acme', analyzedAds: pageAds };
    const out = buildInsights({ meta, metaApi: { ads: apiAds, attempted: true }, linkedin: null, windowDays: 30, maxSampleAds: 2, assumptions: resolveAssumptions(), now: NOW });
    assert.equal(out.meta.sampleAds[0].adArchiveId, 'b');
    assert.equal(out.meta.sampleAds[0].strengthLabel, 'proven');
    assert.equal(out.meta.sampleAds.length, 2);
    assert.equal(out.meta.euTransparency.source, 'meta_ad_library_api');
    assert.equal(out.summary.euReach, 320000);
    assert.ok(out.meta.spendEstimate.monthly.high > out.meta.spendEstimate.monthly.low);
    assert.ok(out.summary.estimatedMonthlySpendEur.high > 0);
    assert.equal(out.summary.provenAds, 1);

    const noToken = buildInsights({ meta, metaApi: null, linkedin: null, windowDays: 30, maxSampleAds: 2, assumptions: resolveAssumptions(), now: NOW });
    assert.match(noToken.meta.euTransparency.note, /Meta access token/);
    assert.equal(noToken.summary.estimatedMonthlySpendEur, null);
});

test('LinkedIn ad detail parsing: impressions, dates, countries, payer', () => {
    const d = parseLinkedInAdDetail('<body><p>Paid for by</p><span>Acme Agency GmbH</span><div>Ran from Mar 3, 2026 to Apr 2, 2026</div><div>Total impressions</div><div>10k-50k</div><div>Impressions by country</div><ul><li>Germany 62%</li><li>Austria < 1%</li></ul></body>');
    assert.deepEqual(d.impressions, { low: 10000, high: 50000, text: '10k-50k' });
    assert.equal(d.ranFrom, '2026-03-03');
    assert.equal(d.ranTo, '2026-04-02');
    assert.deepEqual(d.topCountries, [{ country: 'Germany', share: 0.62 }, { country: 'Austria', share: 0.005 }]);
    assert.equal(d.paidBy, 'Acme Agency GmbH');
    assert.equal(parseLinkedInAdDetail('<body>No data here</body>').impressions, null);
});

test('new signals: set-and-forget, winning creatives, agency payer, big EU spender', () => {
    const meta = {
        checked: true, isRunningAds: true, activeAdsCount: 12, matchConfidence: 'high', longestRunningAdDays: 300, adsAnalyzed: 12, adsStartedInWindow: 0,
        euTransparency: { likelyAgencyPayer: 'Growthly Media GmbH' },
    };
    const insights = { accountActivity: 'static', daysSinceLastNewAd: 140, provenAds: 2, euReach: 1_000_000, businessName: 'Acme', estimatedMonthlySpendEur: { low: 20_000, high: 60_000, tier: 'large' } };
    const ev = evaluate({ meta, google: null, linkedin: null, website: { reachable: true, adPixels: ['metaPixel'] }, insights }, { windowDays: 30 });
    for (const code of ['SET_AND_FORGET', 'WINNING_CREATIVES', 'AGENCY_MANAGED', 'BIG_EU_SPENDER']) assert.ok(ev.signalCodes.includes(code), code);
    assert.ok(!ev.signalCodes.includes('LONG_RUNNING_CREATIVES'), 'static account must not claim long-running winners');
    assert.match(outreachSnippet({ name: 'Acme', domain: 'acme.com', evaluation: ev, meta }), /140\+ days/);
});

test('monitoring counts switched-off ads only when both runs saw every ad', () => {
    const rec = (ids, checkedAt) => ({ checkedAt, meta: { checked: true, isRunningAds: true, activeAdsCount: ids.length } });
    const prev = buildSnapshot(rec(['a', 'b', 'c'], '2026-10-01T00:00:00Z'), { metaAds: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], metaAdsComplete: true });
    const cur = buildSnapshot(rec(['a'], '2026-10-08T00:00:00Z'), { metaAds: [{ id: 'a' }], metaAdsComplete: true, previous: prev });
    assert.equal(diffSnapshots(prev, cur).stoppedMetaAds, 2);
    const partial = buildSnapshot(rec(['a'], '2026-10-08T00:00:00Z'), { metaAds: [{ id: 'a' }], metaAdsComplete: false, previous: prev });
    assert.equal(diffSnapshots(prev, partial).stoppedMetaAds, null);
});
