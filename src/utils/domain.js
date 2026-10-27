import { parse as parseDomain } from 'tldts';

// Hosts that are never "the business's own website" even if a user pastes them.
const PLATFORM_HOSTS = [
    'facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'linkedin.com', 'lnkd.in', 'twitter.com', 'x.com',
    'tiktok.com', 'youtube.com', 'youtu.be', 'pinterest.com', 'google.com', 'goo.gl', 'g.page', 'linktr.ee',
    'wa.me', 'whatsapp.com', 'yelp.com', 'threads.net', 'snapchat.com', 'apple.com/maps', 'bit.ly',
];

const FACEBOOK_RESERVED = new Set([
    'sharer', 'sharer.php', 'share', 'share.php', 'dialog', 'plugins', 'tr', 'login', 'login.php', 'help',
    'policies', 'privacy', 'legal', 'business', 'events', 'groups', 'watch', 'marketplace', 'gaming',
    'hashtag', 'search', 'home.php', 'l.php', 'ads', 'photo.php', 'photo', 'photos', 'video.php', 'story.php',
    'permalink.php', 'media', 'notes', 'pg', 'people', 'public', 'settings', 'messages', 'v2.0', 'v3.0', 'privacy-policy',
]);

export function toUrl(input) {
    if (!input) return null;
    let s = String(input).trim();
    if (!s) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
    try {
        const u = new URL(s);
        if (!['http:', 'https:'].includes(u.protocol)) return null;
        return u;
    } catch {
        return null;
    }
}

/** "https://shop.Acme.co.uk/x" -> "acme.co.uk". Returns null for IPs and invalid input. */
export function registrableDomain(input) {
    if (!input) return null;
    const url = toUrl(input);
    const host = url ? url.hostname : String(input);
    const parsed = parseDomain(host);
    if (!parsed.domain || parsed.isIp) return null;
    return parsed.domain.toLowerCase();
}

/** "acme.co.uk" -> "acme" */
export function domainLabel(domain) {
    if (!domain) return null;
    const parsed = parseDomain(domain);
    return parsed.domainWithoutSuffix || null;
}

export function looksLikeDomain(text) {
    if (!text || /\s/.test(text.trim())) return false;
    const parsed = parseDomain(text.trim().replace(/^https?:\/\//i, '').split('/')[0]);
    return Boolean(parsed.domain && parsed.publicSuffix && parsed.isIcann && !parsed.isIp);
}

export function isPlatformHost(input) {
    const url = toUrl(input);
    if (!url) return false;
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    return PLATFORM_HOSTS.some((p) => {
        const [h, path] = p.split('/');
        return (host === h || host.endsWith(`.${h}`)) && (!path || url.pathname.startsWith(`/${path}`));
    });
}

export function isFacebookUrl(input) {
    const url = toUrl(input);
    if (!url) return false;
    return /(^|\.)(facebook\.com|fb\.com)$/i.test(url.hostname);
}

/**
 * Parses any Facebook URL into what we need for the Ad Library.
 * Returns { slug, pageId, isAdLibrary } or null for share/plugin/etc. links.
 */
export function parseFacebookUrl(input) {
    const url = toUrl(input);
    if (!url || !/(^|\.)(facebook\.com|fb\.com)$/i.test(url.hostname)) return null;
    const path = url.pathname.replace(/\/+$/, '');
    const segments = path.split('/').filter(Boolean);

    if (segments[0] === 'ads' && segments[1] === 'library') {
        const pageId = url.searchParams.get('view_all_page_id');
        return pageId && /^\d+$/.test(pageId) ? { slug: null, pageId, isAdLibrary: true } : null;
    }
    if (segments[0] === 'profile.php') {
        const id = url.searchParams.get('id');
        return id && /^\d+$/.test(id) ? { slug: null, pageId: id, isAdLibrary: false } : null;
    }
    // /pages/Some-Name/123456789 and /pages/category/Name-123456789
    if (segments[0] === 'pages') {
        const numeric = [...segments].reverse().find((s) => /^\d{6,}$/.test(s))
            ?? segments.at(-1)?.match(/-(\d{6,})$/)?.[1];
        return numeric ? { slug: null, pageId: numeric, isAdLibrary: false } : null;
    }
    if (segments[0] === 'people' || segments[0] === 'p') {
        const numeric = segments.find((s) => /^\d{6,}$/.test(s));
        return numeric ? { slug: null, pageId: numeric, isAdLibrary: false } : null;
    }
    const first = segments[0];
    if (!first || FACEBOOK_RESERVED.has(first.toLowerCase())) return null;
    if (/^\d{6,}$/.test(first)) return { slug: null, pageId: first, isAdLibrary: false };
    // Vanity names may end with -<id> (e.g. /Acme-Plumbing-123456789012345).
    const trailingId = first.match(/-(\d{10,})$/)?.[1];
    if (trailingId) return { slug: first, pageId: trailingId, isAdLibrary: false };
    if (!/^[A-Za-z0-9.\-_]{2,100}$/.test(first)) return null;
    return { slug: first, pageId: null, isAdLibrary: false };
}

/** "https://www.linkedin.com/company/hubspot/about" -> "hubspot" */
export function parseLinkedInCompany(input) {
    const url = toUrl(input);
    if (!url || !/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
    const m = url.pathname.match(/^\/(?:company|showcase|school)\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

export function cleanUrl(input) {
    const url = toUrl(input);
    if (!url) return null;
    url.hash = '';
    return url.toString();
}
