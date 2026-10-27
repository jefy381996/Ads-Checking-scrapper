import {
    cleanUrl, isFacebookUrl, isPlatformHost, looksLikeDomain, parseFacebookUrl, parseLinkedInCompany,
    registrableDomain, toUrl,
} from './utils/domain.js';
import { normalizeName } from './utils/text.js';

/**
 * Turns the free-form `businesses` lines and structured `businessRecords` into
 * a de-duplicated list of business descriptors.
 */
export function normalizeBusinesses({ businesses = [], businessRecords = [] }) {
    const out = [];
    const seen = new Map();
    const skipped = [];

    const add = (biz) => {
        if (!biz.domain && !biz.name && !biz.facebook) {
            skipped.push({ input: biz.input, reason: 'Could not find a domain, name or Facebook page in this entry.' });
            return;
        }
        biz.key = businessKey(biz);
        if (seen.has(biz.key)) {
            skipped.push({ input: biz.input, reason: `Duplicate of "${seen.get(biz.key)}".` });
            return;
        }
        seen.set(biz.key, typeof biz.input === 'string' ? biz.input : JSON.stringify(biz.input));
        biz.id = `b${String(out.length + 1).padStart(5, '0')}`;
        out.push(biz);
    };

    for (const line of Array.isArray(businesses) ? businesses : []) {
        if (typeof line !== 'string' || !line.trim()) continue;
        add(parseLine(line.trim()));
    }
    for (const record of Array.isArray(businessRecords) ? businessRecords : []) {
        if (!record || typeof record !== 'object') continue;
        add(parseRecord(record));
    }
    return { businesses: out, skipped };
}

function emptyBusiness(input) {
    return {
        input,
        inputRecord: null,
        name: null,
        domain: null,
        website: null,
        facebook: null, // { slug, pageId, source }
        linkedinSlug: null,
    };
}

export function parseLine(line) {
    const biz = emptyBusiness(line);
    const parts = line.split(/\s*[|\t]\s*/).map((p) => p.trim()).filter(Boolean);
    for (const part of parts) applyToken(biz, part);
    return biz;
}

function applyToken(biz, token) {
    if (isFacebookUrl(token)) {
        const fb = parseFacebookUrl(token);
        if (fb && !biz.facebook) biz.facebook = { slug: fb.slug, pageId: fb.pageId, source: 'input' };
        return;
    }
    const linkedin = parseLinkedInCompany(token);
    if (linkedin) {
        biz.linkedinSlug ??= linkedin;
        return;
    }
    const isUrl = /^https?:\/\//i.test(token) || /^www\./i.test(token);
    if (isUrl || looksLikeDomain(token)) {
        if (isPlatformHost(token)) return; // instagram.com/x, linktr.ee/x... not a business website
        const domain = registrableDomain(token);
        if (domain && !biz.domain) {
            biz.domain = domain;
            biz.website = isUrl ? cleanUrl(token) : `https://${token.replace(/\/+$/, '')}`;
        }
        return;
    }
    if (!biz.name) biz.name = token;
}

export function parseRecord(record) {
    const biz = emptyBusiness(record);
    biz.inputRecord = record;
    const pick = (...keys) => {
        for (const k of keys) {
            const v = record[k];
            if (typeof v === 'string' && v.trim()) return v.trim();
        }
        return null;
    };
    const name = pick('name', 'companyName', 'company', 'businessName', 'title');
    const site = pick('website', 'domain', 'url', 'websiteUrl', 'companyWebsite', 'companyDomain');
    // Array fields cover the output of Apify contact/Google Maps scrapers (facebooks, linkedIns).
    const first = (key) => (Array.isArray(record[key]) && typeof record[key][0] === 'string' ? record[key][0] : null);
    const fbUrl = pick('facebookUrl', 'facebook', 'facebookPage', 'facebookPageUrl') ?? first('facebooks');
    const fbId = record.facebookPageId ?? record.fbPageId ?? record.pageId;
    const li = pick('linkedinUrl', 'linkedin', 'linkedinCompanyUrl') ?? first('linkedIns') ?? first('linkedins');

    if (name) biz.name = name;
    if (site && !isPlatformHost(site)) {
        const domain = registrableDomain(site);
        if (domain) {
            biz.domain = domain;
            biz.website = toUrl(site) ? cleanUrl(site) : `https://${domain}`;
        }
    }
    if (fbId && /^\d{5,}$/.test(String(fbId))) {
        biz.facebook = { slug: null, pageId: String(fbId), source: 'input' };
    } else if (fbUrl) {
        const fb = parseFacebookUrl(fbUrl);
        if (fb) biz.facebook = { slug: fb.slug, pageId: fb.pageId, source: 'input' };
    }
    if (li) biz.linkedinSlug = parseLinkedInCompany(li);
    // Allow a bare string in "website" that is actually a Facebook URL.
    if (!biz.facebook && site && isFacebookUrl(site)) {
        const fb = parseFacebookUrl(site);
        if (fb) biz.facebook = { slug: fb.slug, pageId: fb.pageId, source: 'input' };
    }
    return biz;
}

export function businessKey(biz) {
    if (biz.domain) return `domain:${biz.domain}`;
    if (biz.facebook?.pageId) return `fb:${biz.facebook.pageId}`;
    if (biz.facebook?.slug) return `fbslug:${biz.facebook.slug.toLowerCase()}`;
    return `name:${normalizeName(biz.name)}`;
}

/**
 * Slims an item imported from another Actor's dataset (e.g. Google Maps
 * Scraper) to its identifying scalar fields, so the output stays compact.
 */
export function slimImportedItem(item) {
    const keep = {};
    const preferred = ['title', 'name', 'companyName', 'website', 'domain', 'url', 'phone', 'address', 'city', 'state',
        'countryCode', 'categoryName', 'placeId', 'totalScore', 'reviewsCount', 'id'];
    for (const key of preferred) {
        if (item[key] != null && typeof item[key] !== 'object') keep[key] = item[key];
    }
    for (const key of ['facebooks', 'linkedIns', 'linkedins']) {
        if (Array.isArray(item[key]) && item[key].length) keep[key] = item[key].slice(0, 3);
    }
    return keep;
}
