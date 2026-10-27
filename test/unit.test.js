import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as cheerio from 'cheerio';

import { normalizeBusinesses, parseLine, parseRecord } from '../src/input.js';
import { buildSnapshot, diffSnapshots } from '../src/monitor.js';
import { parseCreative, parseSuggestions, summarizeCreatives } from '../src/platforms/google.js';
import { attributeLinkedInAds, buildLinkedInUrl, parseLinkedInSearch } from '../src/platforms/linkedin.js';
import {
    buildAdLibraryUrl, collectFromDocuments, extractPageIdFromHtml, newCollectState, parseJsonDocuments, parseMetaAd,
    parseResultsText, pickAdvertiser, summarizeMetaAds,
} from '../src/platforms/meta-parse.js';
import { advertiserScore, evaluate, outreachSnippet } from '../src/scoring.js';
import { parseFacebookUrl, parseLinkedInCompany, registrableDomain } from '../src/utils/domain.js';
import { brandFromTitle, nameSimilarity } from '../src/utils/text.js';
import { extractSocialProfiles } from '../src/website/scan.js';
import { AD_PIXELS, ANALYTICS, matchSignatures, unescapeJs } from '../src/website/signatures.js';

const DAY = 86400_000;

test('nameSimilarity handles legal suffixes, spacing and unrelated names', () => {
    assert.equal(nameSimilarity('Allbirds, Inc.', 'allbirds'), 1);
    assert.ok(nameSimilarity('Best Buy', 'BestBuy') >= 0.97);
    assert.ok(nameSimilarity('Allbirds', 'Allbirds Australia') >= 0.85);
    assert.ok(nameSimilarity('Acme Plumbing', 'Zenith Dental') < 0.3);
});

test('brandFromTitle picks the brand part of a title', () => {
    assert.equal(brandFromTitle("Allbirds | Men's & Women's Shoes"), 'Allbirds');
    assert.equal(brandFromTitle('Home - Acme Plumbing'), 'Acme Plumbing');
});

test('registrableDomain and Facebook/LinkedIn URL parsing', () => {
    assert.equal(registrableDomain('https://shop.acme.co.uk/path?q=1'), 'acme.co.uk');
    assert.equal(registrableDomain('192.168.0.1'), null);
    assert.deepEqual(parseFacebookUrl('https://www.facebook.com/gymshark/'), { slug: 'gymshark', pageId: null, isAdLibrary: false });
    assert.equal(parseFacebookUrl('https://www.facebook.com/profile.php?id=100064123456789').pageId, '100064123456789');
    assert.equal(parseFacebookUrl('https://www.facebook.com/ads/library/?view_all_page_id=15087023444').pageId, '15087023444');
    assert.equal(parseFacebookUrl('https://www.facebook.com/sharer/sharer.php?u=x'), null);
    assert.equal(parseFacebookUrl('https://www.facebook.com/Acme-Plumbing-123456789012345').pageId, '123456789012345');
    assert.equal(parseLinkedInCompany('https://www.linkedin.com/company/hubspot/about/'), 'hubspot');
});

test('input lines: domain, name|domain, Facebook URL, platform links', () => {
    const a = parseLine('Allbirds | allbirds.com');
    assert.equal(a.name, 'Allbirds');
    assert.equal(a.domain, 'allbirds.com');
    const b = parseLine('https://www.facebook.com/gymshark');
    assert.equal(b.facebook.slug, 'gymshark');
    assert.equal(b.domain, null);
    const c = parseLine('https://www.instagram.com/acme');
    assert.equal(c.domain, null);
    const d = parseLine('Joe\'s Pizza');
    assert.equal(d.name, "Joe's Pizza");
    const e = parseLine('https://www.hubspot.com/pricing');
    assert.equal(e.domain, 'hubspot.com');
    assert.equal(e.website, 'https://www.hubspot.com/pricing');
});

test('records pass through custom fields and dedupe by key', () => {
    const r = parseRecord({ id: 'crm-1', companyName: 'Acme', website: 'https://acme.com', facebookPageId: '123456789' });
    assert.equal(r.name, 'Acme');
    assert.equal(r.domain, 'acme.com');
    assert.equal(r.facebook.pageId, '123456789');
    assert.equal(r.inputRecord.id, 'crm-1');
    const { businesses, skipped } = normalizeBusinesses({ businesses: ['acme.com', 'www.acme.com', '', 'Acme Corp'], businessRecords: [{ id: 2, domain: 'acme.com' }] });
    assert.equal(businesses.length, 2);
    assert.equal(skipped.length, 2);
    assert.match(businesses[0].id, /^b\d{5}$/);
});

test('pixel signatures detect inline pixels and IDs', () => {
    const html = `
        <script>!function(f,b,e,v,n,t,s){}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
        fbq('init', '1234567890123456'); fbq('track', 'PageView');</script>
        <script async src="https://www.googletagmanager.com/gtag/js?id=AW-987654321"></script>
        <script>gtag('config', 'AW-987654321'); gtag('config', 'G-ABC123XYZ');</script>
        <script>ttq.load('C4ABCDEFGHIJ1234567');</script>
        <script>_linkedin_partner_id = "1234567";</script>
        <script src="//bat.bing.com/bat.js"></script>`;
    const pixels = matchSignatures(html, AD_PIXELS);
    assert.deepEqual(pixels.metaPixel.ids, ['1234567890123456']);
    assert.deepEqual(pixels.googleAds.ids, ['AW-987654321']);
    assert.ok(pixels.tiktokPixel);
    assert.deepEqual(pixels.linkedinInsight.ids, ['1234567']);
    assert.ok(pixels.microsoftUet);
    assert.ok(!pixels.pinterestTag);
    assert.ok(matchSignatures(html, ANALYTICS).ga4);
});

test('GTM container code is unescaped and matched, including built-in tag types', () => {
    const gtm = String.raw`{"function":"__awct","vtp_conversionId":"111222333","vtp_conversionLabel":"abc"},{"function":"__html","vtp_html":"<script>fbq(\"init\",\"9988776655443322\")<\/script>"},{"function":"__bzi","priority":0,"vtp_id":"445566"}`;
    const pixels = matchSignatures(unescapeJs(gtm), AD_PIXELS);
    assert.deepEqual(pixels.googleAds.ids, ['AW-111222333']);
    assert.deepEqual(pixels.metaPixel.ids, ['9988776655443322']);
    assert.deepEqual(pixels.linkedinInsight.ids, ['445566']);
});

test('social profiles prefer JSON-LD sameAs and skip share links', () => {
    const $ = cheerio.load(`
        <a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>
        <a href="https://www.facebook.com/acmefans">fb</a>
        <a href="https://www.instagram.com/p/xyz">post</a>
        <a href="https://www.instagram.com/acme/">ig</a>
        <a href="https://twitter.com/intent/tweet">tweet</a>
        <a href="https://www.linkedin.com/company/acme-inc/">li</a>`);
    const profiles = extractSocialProfiles($, ['https://www.facebook.com/acmeofficial']);
    assert.equal(profiles.facebook, 'https://www.facebook.com/acmeofficial');
    assert.equal(profiles.instagram, 'https://www.instagram.com/acme');
    assert.equal(profiles.linkedin, 'https://www.linkedin.com/company/acme-inc');
    assert.equal(profiles.x, undefined);
});

test('Meta: embedded and streamed GraphQL JSON are collected', () => {
    const now = Math.floor(Date.now() / 1000);
    const ad = (id, startDaysAgo, extra = {}) => ({
        ad_archive_id: id,
        page_id: '555',
        page_name: 'Acme',
        is_active: true,
        start_date: now - startDaysAgo * 86400,
        publisher_platform: ['FACEBOOK', 'INSTAGRAM'],
        snapshot: {
            body: { text: `Ad ${id}` },
            link_url: 'https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.acme.com%2Fsale',
            cta_text: 'Shop now',
            display_format: 'IMAGE',
            page_profile_uri: 'https://www.facebook.com/acmeofficial/',
        },
        ...extra,
    });
    const html = `<html><script type="application/json" data-sjs>${JSON.stringify({ require: [[{ __bbox: { result: { data: { ad_library_main: { search_results_connection: { count: 42, page_info: { has_next_page: true }, edges: [{ node: { collated_results: [ad('1', 2), ad('2', 120)] } }] } } } } } }]] })}</script></html>`;
    const gql = `for (;;);${JSON.stringify({ data: { ad_library_main: { search_results_connection: { count: 42, edges: [{ node: { collated_results: [ad('3', 5)] } }] } } } })}\n${JSON.stringify({ label: 'x', data: {} })}`;

    const state = newCollectState();
    collectFromDocuments(parseJsonDocuments(html), state);
    collectFromDocuments(parseJsonDocuments(gql), state);
    assert.equal(state.totalCount, 42);
    assert.equal(state.ads.size, 3);

    const parsed = parseMetaAd(state.ads.get('1'));
    assert.equal(parsed.linkUrl, 'https://www.acme.com/sale');
    assert.equal(parsed.landingDomain, 'acme.com');

    const summary = summarizeMetaAds([...state.ads.values()], { totalCount: 42, windowDays: 30, maxSampleAds: 2 });
    assert.equal(summary.activeAdsCount, 42);
    assert.equal(summary.adsStartedInWindow, 2);
    assert.ok(summary.longestRunningAdDays >= 119);
    assert.deepEqual(summary.publisherPlatforms, ['FACEBOOK', 'INSTAGRAM']);
    assert.equal(summary.sampleAds.length, 2);
    assert.equal(summary.sampleAds[0].adArchiveId, '1');
});

test('Meta: advertiser attribution prefers domain/slug over name', () => {
    const ads = [
        { pageId: '1', pageName: 'Acme Deals Reseller', landingDomain: 'deals.example', pageProfileUri: 'https://www.facebook.com/acmedeals/' },
        { pageId: '2', pageName: 'ACME Official', landingDomain: 'acme.com', pageProfileUri: 'https://www.facebook.com/acmeofficial/' },
        { pageId: '1', pageName: 'Acme Deals Reseller', landingDomain: 'deals.example', pageProfileUri: null },
    ];
    const { best } = pickAdvertiser(ads, { domains: ['acme.com'], name: 'Acme' });
    assert.equal(best.pageId, '2');
    assert.equal(best.confidence, 'high');
    assert.equal(best.method, 'landing_page_domain');

    const bySlug = pickAdvertiser(ads, { domains: [], name: 'Something Else', facebookSlug: 'acmedeals' });
    assert.equal(bySlug.best.pageId, '1');

    const none = pickAdvertiser([{ pageId: '9', pageName: 'Totally Different', landingDomain: 'x.com' }], { domains: ['acme.com'], name: 'Acme' });
    assert.equal(none.best, null);
});

test('Meta: results text and page ID extraction', () => {
    assert.deepEqual(parseResultsText('Filters ~1,200 results Sort'), { domCount: 1200, noResults: false });
    assert.deepEqual(parseResultsText('~3.4K results'), { domCount: 3400, noResults: false });
    assert.equal(parseResultsText('No ads match your search criteria').domCount, 0);
    assert.equal(parseResultsText('Nothing relevant here').domCount, null);
    const html = '<meta property="og:title" content="Acme &amp; Co" /><script>{"delegate_page":{"is_business_page_active":true,"id":"15087023444"}}</script>';
    assert.deepEqual(extractPageIdFromHtml(html), { pageId: '15087023444', method: 'delegate_page', pageName: 'Acme & Co' });
    assert.equal(extractPageIdFromHtml('<meta property="al:android:url" content="fb://page/?id=1234567" />').pageId, '1234567');
    assert.match(buildAdLibraryUrl({ pageId: '123', country: 'US' }), /view_all_page_id=123.*|search_type=page/);
});

test('Google: suggestions and creatives parsing with epoch scanning', () => {
    const { advertisers, domains } = parseSuggestions({ 1: [{ 1: { 1: 'Acme Inc', 2: 'AR111', 3: 'US', 4: { 2: { 2: '57' } } } }, { 2: { 1: 'acme.com' } }] });
    assert.deepEqual(advertisers[0], { name: 'Acme Inc', id: 'AR111', region: 'US', adCount: 57 });
    assert.deepEqual(domains, ['acme.com']);

    const now = Date.now();
    const recent = Math.floor((now - 3 * DAY) / 1000);
    const old = Math.floor((now - 200 * DAY) / 1000);
    const veryOld = Math.floor((now - 400 * DAY) / 1000);
    const c1 = parseCreative({ 1: 'AR111', 2: 'CR1', 4: 2, 6: { 1: String(old) }, 7: { 1: String(recent) }, 12: 'Acme Inc' });
    const c2 = parseCreative({ 1: 'AR111', 2: 'CR2', 4: 3, 6: { 1: String(veryOld) }, 7: { 1: String(old) }, 12: 'Acme Inc' });
    assert.equal(c1.format, 'IMAGE');
    assert.equal(Date.parse(c1.lastShown), recent * 1000);
    const s = summarizeCreatives([c1, c2], { hasNextPage: false, windowDays: 30, maxSampleAds: 5, now });
    assert.equal(s.isRunningAds, true);
    assert.equal(s.activeCreativesInWindow, 1);
    assert.equal(s.advertiserId, 'AR111');
    assert.equal(s.daysSinceLastShown, 3);
    assert.equal(s.activityBasis, 'last_shown_date');
    assert.equal(parseCreative({ 1: 'AR1' }), null);
});

test('LinkedIn: parse cards, verify advertiser, build URL', () => {
    const html = `<ul>
        <li><a href="https://www.linkedin.com/company/hubspot?trk=x">HubSpot</a><p>Grow better</p><a href="/ad-library/detail/111?trk=y">View</a></li>
        <li><a href="https://www.linkedin.com/company/hubspot-academy">HubSpot Academy</a><a href="/ad-library/detail/222">View</a></li>
        <li><a href="https://www.linkedin.com/company/spotify">Spotify</a><a href="/ad-library/detail/333">View</a></li>
    </ul>`;
    const { ads } = parseLinkedInSearch(html);
    assert.equal(ads.length, 3);
    assert.equal(ads[0].advertiserSlug, 'hubspot');
    const bySlug = attributeLinkedInAds(ads, { name: 'HubSpot', slug: 'hubspot', maxSampleAds: 3 });
    assert.equal(bySlug.adsFound, 1);
    assert.equal(bySlug.matchConfidence, 'high');
    const byName = attributeLinkedInAds(ads, { name: 'HubSpot', slug: null, maxSampleAds: 3 });
    assert.equal(byName.adsFound, 1);
    assert.equal(byName.matchConfidence, 'medium');
    const url = buildLinkedInUrl({ name: 'HubSpot', country: 'ALL', windowDays: 90, now: new Date('2026-10-27T00:00:00Z') });
    assert.match(url, /accountOwner=HubSpot/);
    assert.match(url, /dateOption=custom-date-range&startdate=2026-07-29&enddate=2026-10-27/);
});

test('scoring: verdicts, signals and snippet', () => {
    const meta = { checked: true, isRunningAds: true, activeAdsCount: 2, matchConfidence: 'high', longestRunningAdDays: 120, adsAnalyzed: 2, adsStartedInWindow: 0 };
    const google = { checked: true, isRunningAds: false, matchConfidence: 'high', activeCreativesInWindow: 0 };
    const website = { reachable: true, adPixels: ['googleAds'], ecommercePlatform: 'Shopify' };
    const ev = evaluate({ meta, google, linkedin: null, website }, { windowDays: 30 });
    assert.equal(ev.verdict, 'RUNNING_ADS');
    assert.equal(ev.confidence, 'high');
    assert.deepEqual(ev.activePlatforms, ['meta']);
    for (const code of ['META_ADS_WITHOUT_PIXEL', 'GOOGLE_TAG_NO_ACTIVE_ADS', 'SINGLE_CHANNEL', 'LONG_RUNNING_CREATIVES', 'LOW_CREATIVE_VOLUME', 'ECOMMERCE_STORE']) {
        assert.ok(ev.signalCodes.includes(code), code);
    }
    const snippet = outreachSnippet({ name: 'Acme', domain: 'acme.com', evaluation: ev, meta, google });
    assert.match(snippet, /2 live Meta ads/);

    const failed = evaluate({ meta: { checked: true, error: 'blocked' }, google: { checked: true, error: 'x' }, linkedin: null, website: null }, { windowDays: 30 });
    assert.equal(failed.verdict, 'INCONCLUSIVE');
    const pixelsOnly = evaluate({ meta: { checked: true, isRunningAds: false, matchConfidence: 'high' }, google: null, linkedin: null, website: { reachable: true, adPixels: ['metaPixel'] } }, { windowDays: 30 });
    assert.equal(pixelsOnly.verdict, 'AD_PIXELS_ONLY');
    assert.ok(pixelsOnly.signalCodes.includes('META_PIXEL_NO_ACTIVE_ADS'));

    assert.ok(advertiserScore({ meta: { isRunningAds: true, activeAdsCount: 100 }, google: { isRunningAds: true, activeCreativesInWindow: 50 }, linkedin: null, pixels: new Set(['metaPixel']) }) >= 80);
    assert.ok(advertiserScore({ meta: null, google: null, linkedin: null, pixels: new Set() }) === 0);
});

test('monitoring: started/stopped, errors carry over, new ads by date', () => {
    const t0 = '2026-10-01T00:00:00.000Z';
    const prev = buildSnapshot({
        checkedAt: t0,
        meta: { checked: true, isRunningAds: true, activeAdsCount: 2 },
        google: { checked: true, isRunningAds: false, activeCreativesInWindow: 0 },
        website: { reachable: true, adPixels: ['metaPixel'] },
    }, { metaAds: [{ id: 'a', start: '2026-09-01T00:00:00.000Z' }, { id: 'b', start: '2026-09-20T00:00:00.000Z' }] });

    const cur = buildSnapshot({
        checkedAt: '2026-10-08T00:00:00.000Z',
        meta: { checked: true, isRunningAds: true, activeAdsCount: 3 },
        google: { checked: true, error: 'blocked' },
        website: { reachable: true, adPixels: ['metaPixel', 'googleAds'] },
    }, { metaAds: [{ id: 'a', start: '2026-09-01T00:00:00.000Z' }, { id: 'c', start: '2026-10-05T00:00:00.000Z' }, { id: 'old-unseen', start: '2026-08-01T00:00:00.000Z' }], previous: prev });

    assert.equal(cur.platforms.google.carriedOver, true);
    const diff = diffSnapshots(prev, cur);
    assert.equal(diff.status, 'NEW_ADS');
    assert.equal(diff.newMetaAds, 1);
    assert.deepEqual(diff.newAdPixels, ['googleAds']);

    const stopped = buildSnapshot({ checkedAt: '2026-10-09T00:00:00.000Z', meta: { checked: true, isRunningAds: false, activeAdsCount: 0 } }, { previous: cur });
    assert.equal(diffSnapshots(cur, stopped).status, 'STOPPED_ADVERTISING');
    assert.equal(diffSnapshots(null, cur).status, 'FIRST_CHECK');
});

test('Google Maps Scraper items import cleanly', async () => {
    const { slimImportedItem } = await import('../src/input.js');
    const item = {
        title: "Joe's Plumbing", website: 'https://joesplumbing.com/', url: 'https://www.google.com/maps/place/x',
        phone: '+1 555', reviews: [{ text: 'big nested array' }], facebooks: ['https://www.facebook.com/joesplumbingatx'],
    };
    const slim = slimImportedItem(item);
    assert.equal(slim.reviews, undefined);
    const biz = parseRecord(slim);
    assert.equal(biz.name, "Joe's Plumbing");
    assert.equal(biz.domain, 'joesplumbing.com');
    assert.equal(biz.facebook.slug, 'joesplumbingatx');
    const noSite = parseRecord(slimImportedItem({ title: 'No Site Cafe', url: 'https://www.google.com/maps/place/y' }));
    assert.equal(noSite.domain, null);
    assert.equal(noSite.name, 'No Site Cafe');
});
