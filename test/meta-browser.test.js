// Integration test of the Meta crawler plumbing (navigation, GraphQL
// interception, waiting, multi-step flows, keepAlive/stop) against a local
// HTTPS server that impersonates www.facebook.com via Chrome host rules.
// It validates our code paths, NOT Meta's live response format.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'meta-test-'));
process.env.CRAWLEE_STORAGE_DIR = join(tmp, 'storage');

const { log } = await import('crawlee');
const { createMetaCrawler, firstMetaRequest } = await import('../src/platforms/meta.js');

const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const canRun = (() => {
    try {
        execFileSync('openssl', ['version']);
        return existsSync(CHROMIUM) || Boolean(process.env.CHROMIUM_PATH);
    } catch {
        return false;
    }
})();

const now = Math.floor(Date.now() / 1000);
const ad = (id, pageId, pageName, domain, daysAgo) => ({
    ad_archive_id: id,
    page_id: pageId,
    page_name: pageName,
    is_active: true,
    start_date: now - daysAgo * 86400,
    publisher_platform: ['FACEBOOK'],
    snapshot: { body: { text: `Ad ${id}` }, link_url: `https://${domain}/x`, page_profile_uri: `https://www.facebook.com/${pageName.toLowerCase().replace(/\s+/g, '')}/` },
});
const conn = (count, ads, hasNext) => ({ ad_library_main: { search_results_connection: { count, page_info: { has_next_page: hasNext }, edges: [{ node: { collated_results: ads } }] } } });
const page = (data, { fetchMore = false } = {}) => `<!doctype html><html><body><div id="r">Loading</div>
<script type="application/json" data-sjs>${JSON.stringify({ require: [[{ __bbox: { result: { data } } }]] })}</script>
${fetchMore ? '<script>setTimeout(() => fetch("/api/graphql/", { method: "POST", body: "q" }).then(r => r.text()), 300)</script>' : ''}
</body></html>`;

function handler(req, res) {
    const url = new URL(req.url, 'https://www.facebook.com');
    const send = (status, body, headers = {}) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
        res.end(body);
    };
    if (url.pathname === '/api/graphql/') {
        return send(200, `for (;;);${JSON.stringify({ data: conn(42, [ad('3', '100200300400', 'Acme Official', 'acme.com', 5)], false) })}`, { 'content-type': 'application/json' });
    }
    if (url.pathname === '/acmeofficial') {
        return send(200, '<html><head><meta property="og:title" content="Acme Official"></head><script>{"delegate_page":{"id":"100200300400"}}</script></html>');
    }
    if (url.pathname.startsWith('/login')) return send(200, '<html>Log in</html>');
    if (url.pathname === '/ads/library/') {
        const pageId = url.searchParams.get('view_all_page_id');
        if (pageId === '100200300400') {
            return send(200, page(conn(42, [ad('1', '100200300400', 'Acme Official', 'acme.com', 2), ad('2', '100200300400', 'Acme Official', 'acme.com', 150)], true), { fetchMore: true }));
        }
        if (pageId === '700800900') return send(200, page(conn(0, [], false)));
        if (pageId === '900900900') return send(302, '', { location: '/login/?next=x' });
        if (url.searchParams.get('q') === 'Acme') {
            return send(200, page(conn(null, [
                ad('10', '1', 'Acme Deals Reseller', 'deals.example', 3),
                ad('11', '100200300400', 'Acme Official', 'acme.com', 4),
            ], false)));
        }
        if (url.searchParams.get('q') === 'Nobody') return send(200, page(conn(0, [], false)));
    }
    return send(404, 'not found');
}

test('Meta crawler flows end to end against a fake Ad Library', { skip: !canRun && 'openssl or Chromium not available', timeout: 180_000 }, async () => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tmp, 'k.pem'), '-out', join(tmp, 'c.pem'), '-days', '1', '-subj', '/CN=www.facebook.com'], { stdio: 'ignore' });
    const server = https.createServer({ key: readFileSync(join(tmp, 'k.pem')), cert: readFileSync(join(tmp, 'c.pem')) }, handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

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
            args: [`--host-resolver-rules=MAP www.facebook.com 127.0.0.1:${port}`, '--ignore-certificate-errors', '--no-proxy-server', '--disable-dev-shm-usage'],
        },
    });
    const run = crawler.run();
    await crawler.addRequests([...contexts.values()].map((ctx) => firstMetaRequest(ctx, { attempt: 'T1', country: 'ALL' })));
    // A stale request from a "previous attempt" must be skipped without a result.
    await crawler.addRequests([{ url: 'https://www.facebook.com/ads/library/?stale=1', uniqueKey: 'stale', userData: { label: 'ADLIB_PAGE', bizId: 'byPageId', attempt: 'OLD' } }]);
    await run;
    server.close();

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
