// Full pipeline: runs the real src/main.js (input -> Meta browser check against
// the fake Ad Library -> ad strength -> billing -> dataset) with pay-per-event
// simulated locally by the Apify SDK, then inspects the dataset and charge log.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CHROMIUM, canRun, startFakeFacebook } from './fixtures/fake-facebook.js';

const PRICING = {
    pricingModel: 'PAY_PER_EVENT',
    pricingPerEvent: {
        actorChargeEvents: {
            'business-checked': { eventPriceUsd: 0.005, eventTitle: 'Business checked' },
            'meta-ads-checked': { eventPriceUsd: 0.045, eventTitle: 'Meta Ad Library check' },
            'eu-insights': { eventPriceUsd: 0.01, eventTitle: 'EU insights' },
        },
    },
};

function readItems(dir) {
    try {
        return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
    } catch {
        return [];
    }
}

function runActor(storage, input, env) {
    mkdirSync(join(storage, 'key_value_stores', 'default'), { recursive: true });
    writeFileSync(join(storage, 'key_value_stores', 'default', 'INPUT.json'), JSON.stringify(input));
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['src/main.js'], {
            cwd: new URL('..', import.meta.url).pathname,
            env: { ...process.env, CRAWLEE_STORAGE_DIR: storage, APIFY_LOCAL_STORAGE_DIR: storage, ...env },
        });
        let output = '';
        child.stdout.on('data', (d) => { output += d; });
        child.stderr.on('data', (d) => { output += d; });
        child.on('exit', (code) => resolve({ code, output }));
    });
}

test('main.js end to end: Meta check, ad strength, billing', { skip: !canRun && 'openssl or Chromium not available', timeout: 180_000 }, async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pipeline-'));
    const fake = await startFakeFacebook(tmp);
    const storage = join(tmp, 'storage');
    const { code, output } = await runActor(storage, {
        businesses: [
            'Acme | https://www.facebook.com/ads/library/?view_all_page_id=100200300400',
            'Quiet Co | https://www.facebook.com/ads/library/?view_all_page_id=700800900',
            'Euro Co | https://www.facebook.com/ads/library/?view_all_page_id=300400500600',
        ],
        checkGoogle: false,
        checkLinkedIn: false,
        scanWebsite: false,
        maxSampleAds: 2,
        euInsights: true,
    }, {
        CHROMIUM_PATH: CHROMIUM,
        CHROMIUM_ARGS: JSON.stringify(fake.chromeArgs),
        ACTOR_TEST_PAY_PER_EVENT: 'true',
        ACTOR_USE_CHARGING_LOG_DATASET: 'true',
        APIFY_ACTOR_PRICING_INFO: JSON.stringify(PRICING),
        APIFY_CHARGED_ACTOR_EVENT_COUNTS: '{}',
        ACTOR_MAX_TOTAL_CHARGE_USD: '5',
    });
    await fake.close();
    assert.equal(code, 0, output.slice(-3000));

    const items = readItems(join(storage, 'datasets', 'default'));
    assert.equal(items.length, 3);
    const acme = items.find((i) => i.businessName === 'Acme');
    assert.equal(acme.verdict, 'RUNNING_ADS');
    assert.equal(acme.meta.activeAdsCount, 42);
    assert.equal(acme.adStrength.adsScored, 3);
    assert.equal(acme.meta.sampleAds.length, 2);
    assert.equal(acme.meta.sampleAds[0].adArchiveId, '2', 'the 150-day, 6-copy ad must rank first');
    assert.equal(acme.meta.sampleAds[0].strengthLabel, 'proven');
    assert.equal(acme.meta.analyzedAds, undefined, 'internal fields must not leak');
    assert.equal(acme.estimatedMonthlySpendEur, null, 'no EU reach without a token, so no spend estimate');
    assert.match(acme.meta.euTransparency.note, /Meta access token/);

    const quiet = items.find((i) => i.businessName === 'Quiet Co');
    assert.equal(quiet.verdict, 'NOT_RUNNING_ADS');
    assert.equal(quiet.adStrength, null);

    // EU reach present in the page data -> modelled spend range, flagged as extrapolated.
    const euro = items.find((i) => i.businessName === 'Euro Co');
    assert.equal(euro.euReach, 290000);
    assert.equal(euro.meta.euTransparency.source, 'ad_library_page');
    assert.equal(euro.meta.spendEstimate.adsWithData, 2);
    assert.equal(euro.meta.spendEstimate.activeAds, 5);
    assert.equal(euro.meta.spendEstimate.confidence, 'very_low');
    assert.ok(euro.meta.spendEstimate.monthlyExtrapolated.high > euro.meta.spendEstimate.monthly.high);
    assert.ok(euro.estimatedMonthlySpendEur.low > 0 && euro.estimatedMonthlySpendEur.high > euro.estimatedMonthlySpendEur.low);
    assert.match(euro.estimatedMonthlySpendEur.disclaimer, /not actual spend/);

    const charges = readItems(join(storage, 'datasets', 'charging_log'));
    const count = (name) => charges.filter((c) => c.eventName === name).reduce((s, c) => s + c.chargedCount, 0);
    assert.equal(count('business-checked'), 3);
    assert.equal(count('meta-ads-checked'), 3);
    assert.equal(count('eu-insights'), 1, 'EU insights are billed only for the business with EU data');
});

test('main.js respects the maximum charge per run', { timeout: 60_000 }, async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'budget-'));
    const storage = join(tmp, 'storage');
    const { code, output } = await runActor(storage, {
        businesses: ['a-example.com', 'b-example.com', 'c-example.com'],
        checkMeta: false,
        checkGoogle: false,
        checkLinkedIn: false,
        scanWebsite: false,
        euInsights: false,
    }, {
        ACTOR_TEST_PAY_PER_EVENT: 'true',
        APIFY_ACTOR_PRICING_INFO: JSON.stringify(PRICING),
        APIFY_CHARGED_ACTOR_EVENT_COUNTS: '{}',
        ACTOR_MAX_TOTAL_CHARGE_USD: '0.011',
    });
    assert.equal(code, 0, output.slice(-2000));
    assert.match(output, /covers 2 of 3 businesses/);
    assert.equal(readItems(join(storage, 'datasets', 'default')).length, 2);
});
