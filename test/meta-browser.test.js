// Integration test of the Meta crawler plumbing (navigation, GraphQL
// interception, waiting, multi-step flows, keepAlive/stop) against a local
// HTTPS server that impersonates www.facebook.com via Chrome host rules.
// It validates our code paths, NOT Meta's live response format.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CHROMIUM, canRun, startFakeFacebook } from './fixtures/fake-facebook.js';

const tmp = mkdtempSync(join(tmpdir(), 'meta-test-'));
process.env.CRAWLEE_STORAGE_DIR = join(tmp, 'storage');

const { log } = await import('crawlee');
const { createMetaCrawler, firstMetaRequest } = await import('../src/platforms/meta.js');

test('Meta crawler flows end to end against a fake Ad Library', { skip: !canRun && 'openssl or Chromium not available', timeout: 180_000 }, async () => {
    const fake = await startFakeFacebook(tmp);

    const biz = (id, extra) => ({ id, key: id, name: null, domain: null, facebook: null, ...extra });
    const contexts = new Map(Object.entries({
        byPageId: { biz: biz('byPageId', { facebook: { pageId: '100200300400', source: 'input' } }) },
        bySlug: { biz: biz('bySlug', { facebook: { slug: 'acmeofficial', source: 'website' } }) },
        byKeyword: { biz: biz('byKeyword', { domain: 'acme.com', name: 'Acme' }), query: 'Acme', name: 'Acme', domains: ['acme.com'] },
        zero: { biz: biz('zero', { facebook: { pageId: '700800900', source: 'input' } }) },
        noMatch: { biz: biz('noMatch', { name: 'Nobody' }), query: 'Nobody', name: 'Nobody', domains: [] },
        blocked: { biz: biz('blocked', { facebook: { pageId: '900900900', source: 'input' } }) },
    }).map(([k, v]) => [k, { windowDays: 30, maxSampleAds: 3, keywordFallback: true, domains: [], ...v }]));

    const results = new Map();
    log.setLevel(log.LEVELS.WARNING);
    const crawler = createMetaCrawler({
        proxyConfiguration: undefined,
        maxConcurrency: 3,
        country: 'ALL',
        attempt: 'T1',
        log,
        getContext: (id) => contexts.get(id) ?? null,
        onDone: async (id, r) => {
            results.set(id, r);
            if (results.size === contexts.size) crawler.stop();
        },
        launchOptions: {
            executablePath: CHROMIUM,
            args: fake.chromeArgs,
        },
    });
    const run = crawler.run();
    await crawler.addRequests([...contexts.values()].map((ctx) => firstMetaRequest(ctx, { attempt: 'T1', country: 'ALL' })));
    // A stale request from a "previous attempt" must be skipped without a result.
    await crawler.addRequests([{ url: 'https://www.facebook.com/ads/library/?stale=1', uniqueKey: 'stale', userData: { label: 'ADLIB_PAGE', bizId: 'byPageId', attempt: 'OLD' } }]);
    await run;
    await fake.close();

    const byPageId = results.get('byPageId');
    assert.equal(byPageId.error, null);
    assert.equal(byPageId.isRunningAds, true);
    assert.equal(byPageId.activeAdsCount, 42);
    assert.equal(byPageId.adsAnalyzed, 3, 'GraphQL response after load must be captured');
    assert.ok(byPageId.longestRunningAdDays >= 149);
    assert.equal(byPageId.matchConfidence, 'high');

    const bySlug = results.get('bySlug');
    assert.equal(bySlug.pageId, '100200300400');
    assert.match(bySlug.matchMethod, /facebook_page_html:delegate_page/);

    const byKeyword = results.get('byKeyword');
    assert.equal(byKeyword.pageId, '100200300400');
    assert.equal(byKeyword.matchMethod, 'landing_page_domain');
    assert.equal(byKeyword.activeAdsCount, 42);

    const zero = results.get('zero');
    assert.equal(zero.error, null);
    assert.equal(zero.isRunningAds, false);
    assert.equal(zero.activeAdsCount, 0);

    const noMatch = results.get('noMatch');
    assert.equal(noMatch.isRunningAds, false);
    assert.equal(noMatch.matchMethod, 'keyword_search');

    const blocked = results.get('blocked');
    assert.match(blocked.error, /login wall/);
});
