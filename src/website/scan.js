import * as cheerio from 'cheerio';

import { parseFacebookUrl, parseLinkedInCompany, registrableDomain } from '../utils/domain.js';
import { errorMessage, fetchText } from '../utils/http.js';
import { brandFromTitle, truncate } from '../utils/text.js';
import {
    AD_PIXELS, ANALYTICS, ECOMMERCE_PLATFORMS, MARKETING_TOOLS, matchSignatures, unescapeJs,
} from './signatures.js';

const MAX_CONTAINERS = 4;

export function emptyWebsiteResult() {
    return {
        checked: false,
        reachable: false,
        finalUrl: null,
        finalDomain: null,
        httpStatus: null,
        title: null,
        siteName: null,
        titleBrand: null,
        adPixels: [],
        adPixelDetails: {},
        analytics: [],
        marketingTools: [],
        ecommercePlatform: null,
        socialProfiles: {},
        tagManagerContainers: [],
        tagManagersScanned: 0,
        error: null,
    };
}

/**
 * Fetches a business homepage and detects ad pixels, analytics, marketing
 * tools, e-commerce platform and official social profiles.
 */
export async function scanWebsite(biz, { proxyConfiguration, scanTagManagers = true, log }) {
    const result = emptyWebsiteResult();
    result.checked = true;
    const candidates = [...new Set([
        biz.website,
        `https://${biz.domain}`,
        `https://www.${biz.domain}`,
        `http://${biz.domain}`,
    ].filter(Boolean))];

    let page = null;
    let lastProblem = null;
    for (const url of candidates) {
        try {
            const res = await fetchText(url, { proxyConfiguration, sessionId: `web_${biz.id}`, retries: 1, timeoutMs: 25_000 });
            const isHtml = /<html|<head|<body|<script/i.test(res.body.slice(0, 20_000));
            if (res.statusCode < 400 && isHtml) {
                page = res;
                break;
            }
            lastProblem = `HTTP ${res.statusCode}${isHtml ? '' : ' (not HTML)'} from ${url}`;
            result.httpStatus = res.statusCode;
        } catch (err) {
            lastProblem = `${errorMessage(err)} (${url})`;
        }
    }
    if (!page) {
        result.error = lastProblem ?? 'Website could not be fetched';
        return result;
    }

    result.reachable = true;
    result.httpStatus = page.statusCode;
    result.finalUrl = page.url;
    result.finalDomain = registrableDomain(page.url);

    const html = page.body;
    const $ = cheerio.load(html);
    result.title = truncate($('title').first().text(), 200);
    const jsonLd = extractJsonLd($);
    // siteName is only taken from explicit declarations; titleBrand is a guess.
    result.siteName = truncate(
        $('meta[property="og:site_name"]').attr('content')
        || jsonLd.organizationName
        || $('meta[name="application-name"]').attr('content'),
        120,
    );
    result.titleBrand = brandFromTitle(result.title);
    result.socialProfiles = extractSocialProfiles($, jsonLd.sameAs);

    const pixels = tagSource(matchSignatures(html, AD_PIXELS), 'html');
    const analytics = matchSignatures(html, ANALYTICS);
    const marketing = matchSignatures(html, MARKETING_TOOLS);
    const platforms = matchSignatures(html, ECOMMERCE_PLATFORMS);
    // A specific platform beats the generic WordPress match (WooCommerce runs on WordPress).
    const platformKeys = Object.keys(platforms);
    result.ecommercePlatform = platformKeys.find((k) => k !== 'WordPress') ?? platformKeys[0] ?? null;

    if (scanTagManagers) {
        const containers = [
            ...(analytics.gtm?.ids ?? []),
            ...findGtagIds(html),
        ];
        const unique = [...new Set(containers)].slice(0, MAX_CONTAINERS);
        result.tagManagerContainers = unique;
        for (const id of unique) {
            const url = id.startsWith('GTM-')
                ? `https://www.googletagmanager.com/gtm.js?id=${id}`
                : `https://www.googletagmanager.com/gtag/js?id=${id}`;
            try {
                const res = await fetchText(url, { proxyConfiguration, sessionId: `gtm_${biz.id}`, retries: 1, timeoutMs: 15_000 });
                if (res.statusCode >= 400) continue;
                result.tagManagersScanned++;
                const code = unescapeJs(res.body);
                mergeFindings(pixels, tagSource(matchSignatures(code, AD_PIXELS), id));
                mergeFindings(analytics, matchSignatures(code, ANALYTICS));
            } catch (err) {
                log?.debug?.(`Tag manager ${id} for ${biz.domain} failed: ${errorMessage(err)}`);
            }
        }
    }

    result.adPixels = Object.keys(pixels);
    result.adPixelDetails = Object.fromEntries(Object.entries(pixels).map(([k, v]) => [k, {
        label: v.label, platform: v.platform, ids: v.ids, foundIn: [...v.foundIn],
    }]));
    result.analytics = Object.keys(analytics);
    result.marketingTools = Object.keys(marketing);
    return result;
}

function tagSource(findings, source) {
    for (const f of Object.values(findings)) f.foundIn = new Set([source]);
    return findings;
}

function mergeFindings(target, extra) {
    for (const [key, f] of Object.entries(extra)) {
        if (!target[key]) {
            target[key] = { ...f, foundIn: new Set(f.foundIn ?? []) };
            continue;
        }
        target[key].ids = [...new Set([...target[key].ids, ...f.ids])].slice(0, 10);
        for (const s of f.foundIn ?? []) target[key].foundIn?.add(s);
    }
}

function findGtagIds(html) {
    const ids = new Set();
    for (const m of html.matchAll(/googletagmanager\.com\/gtag\/js\?id=((?:G|AW|DC|GT)-[A-Z0-9]{4,14})/gi)) ids.add(m[1].toUpperCase());
    for (const m of html.matchAll(/gtag\(\s*['"]config['"]\s*,\s*['"]((?:G|AW)-[A-Z0-9]{4,14})['"]/g)) ids.add(m[1]);
    return [...ids];
}

function extractJsonLd($) {
    const sameAs = [];
    let organizationName = null;
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const data = JSON.parse($(el).contents().text());
            const nodes = [data, ...(Array.isArray(data) ? data : []), ...(data?.['@graph'] ?? [])];
            for (const node of nodes) {
                if (!node || typeof node !== 'object') continue;
                const type = [].concat(node['@type'] ?? []).join(' ');
                if (/Organization|LocalBusiness|Store|Corporation|Brand|WebSite/i.test(type)) {
                    if (!organizationName && typeof node.name === 'string' && !/WebSite/i.test(type)) organizationName = node.name;
                    for (const url of [].concat(node.sameAs ?? [])) if (typeof url === 'string') sameAs.push(url);
                }
            }
        } catch {
            // Invalid JSON-LD is common; ignore it.
        }
    });
    return { sameAs, organizationName };
}

const SOCIAL_RULES = [
    { key: 'facebook', test: (u) => /(^|\.)facebook\.com$/i.test(u.hostname), normalize: (href) => {
        const fb = parseFacebookUrl(href);
        if (!fb || fb.isAdLibrary) return null;
        return fb.slug ? `https://www.facebook.com/${fb.slug}` : `https://www.facebook.com/${fb.pageId}`;
    } },
    { key: 'instagram', test: (u) => /(^|\.)instagram\.com$/i.test(u.hostname), normalize: (href) => {
        const m = href.match(/instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#]|$)/i);
        return m && !/^(p|reel|reels|explore|accounts|stories|tv|direct)$/i.test(m[1]) ? `https://www.instagram.com/${m[1]}` : null;
    } },
    { key: 'linkedin', test: (u) => /(^|\.)linkedin\.com$/i.test(u.hostname), normalize: (href) => {
        const slug = parseLinkedInCompany(href);
        return slug ? `https://www.linkedin.com/company/${slug}` : null;
    } },
    { key: 'tiktok', test: (u) => /(^|\.)tiktok\.com$/i.test(u.hostname), normalize: (href) => {
        const m = href.match(/tiktok\.com\/@([\w.]{2,24})/i);
        return m ? `https://www.tiktok.com/@${m[1]}` : null;
    } },
    { key: 'youtube', test: (u) => /(^|\.)youtube\.com$/i.test(u.hostname), normalize: (href) => {
        const m = href.match(/youtube\.com\/(@[\w.-]+|channel\/[\w-]+|c\/[\w-]+|user\/[\w-]+)/i);
        return m ? `https://www.youtube.com/${m[1]}` : null;
    } },
    { key: 'x', test: (u) => /(^|\.)(twitter|x)\.com$/i.test(u.hostname), normalize: (href) => {
        const m = href.match(/(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/?(?:[?#]|$)/i);
        return m && !/^(share|intent|home|i|search|hashtag|login)$/i.test(m[1]) ? `https://x.com/${m[1]}` : null;
    } },
    { key: 'pinterest', test: (u) => /(^|\.)pinterest\.[a-z.]+$/i.test(u.hostname), normalize: (href) => {
        const m = href.match(/pinterest\.[a-z.]+\/([\w-]{3,30})\/?(?:[?#]|$)/i);
        return m && !/^(pin|search|ideas)$/i.test(m[1]) ? `https://www.pinterest.com/${m[1]}` : null;
    } },
];

/** Picks the most frequently linked profile per network (footer/header links repeat). */
export function extractSocialProfiles($, extraUrls = []) {
    const counts = {};
    const consider = (href, weight) => {
        if (!href || typeof href !== 'string') return;
        let url;
        try {
            url = new URL(href, 'https://example.com');
        } catch {
            return;
        }
        for (const rule of SOCIAL_RULES) {
            if (!rule.test(url)) continue;
            const normalized = rule.normalize(url.toString());
            if (!normalized) return;
            counts[rule.key] ??= {};
            counts[rule.key][normalized] = (counts[rule.key][normalized] ?? 0) + weight;
            return;
        }
    };
    $('a[href]').each((_, el) => consider($(el).attr('href'), 1));
    // JSON-LD sameAs is the site owner's explicit declaration: weight it higher.
    for (const url of extraUrls) consider(url, 5);

    const profiles = {};
    for (const [network, urls] of Object.entries(counts)) {
        profiles[network] = Object.entries(urls).sort((a, b) => b[1] - a[1])[0][0];
    }
    return profiles;
}
