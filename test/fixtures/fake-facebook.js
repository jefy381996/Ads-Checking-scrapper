// A local HTTPS server that impersonates www.facebook.com for browser tests.
// Chrome is pointed at it with --host-resolver-rules, so production code runs
// unchanged. It reproduces the response SHAPES our parser expects; it says
// nothing about whether Meta's live responses still look like this.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { join } from 'node:path';

export const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
export const canRun = (() => {
    try {
        execFileSync('openssl', ['version']);
        return existsSync(CHROMIUM) || Boolean(process.env.CHROMIUM_PATH);
    } catch {
        return false;
    }
})();

const now = Math.floor(Date.now() / 1000);
const ad = (id, pageId, pageName, domain, daysAgo, extra = {}) => ({
    ad_archive_id: id,
    page_id: pageId,
    page_name: pageName,
    is_active: true,
    start_date: now - daysAgo * 86400,
    publisher_platform: ['FACEBOOK'],
    ...extra,
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
            return send(200, page(conn(42, [ad('1', '100200300400', 'Acme Official', 'acme.com', 2), ad('2', '100200300400', 'Acme Official', 'acme.com', 150, { collation_count: 6, publisher_platform: ['FACEBOOK', 'INSTAGRAM', 'MESSENGER', 'AUDIENCE_NETWORK'] })], true), { fetchMore: true }));
        }
        if (pageId === '700800900') return send(200, page(conn(0, [], false)));
        if (pageId === '300400500600') {
            return send(200, page(conn(5, [
                ad('20', '300400500600', 'Euro Co', 'euro.example', 40, { eu_total_reach: 250000, collation_count: 3 }),
                ad('21', '300400500600', 'Euro Co', 'euro.example', 10, { eu_total_reach: 40000 }),
            ], false)));
        }
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


/** Starts the fake server; returns { port, close, chromeArgs }. */
export async function startFakeFacebook(tmp) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tmp, 'k.pem'), '-out', join(tmp, 'c.pem'), '-days', '1', '-subj', '/CN=www.facebook.com'], { stdio: 'ignore' });
    const server = https.createServer({ key: readFileSync(join(tmp, 'k.pem')), cert: readFileSync(join(tmp, 'c.pem')) }, handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    return {
        port,
        close: () => new Promise((r) => server.close(r)),
        chromeArgs: [`--host-resolver-rules=MAP www.facebook.com 127.0.0.1:${port}`, '--ignore-certificate-errors', '--no-proxy-server', '--disable-dev-shm-usage'],
    };
}
