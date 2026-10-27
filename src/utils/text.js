// Name normalization and fuzzy matching used to decide whether an advertiser
// found in an ad library is the business we were asked about.

const LEGAL_SUFFIXES = new Set([
    'inc', 'incorporated', 'llc', 'l.l.c', 'ltd', 'limited', 'co', 'corp', 'corporation', 'company',
    'plc', 'gmbh', 'ag', 'sa', 'sas', 'sarl', 'srl', 'spa', 'bv', 'nv', 'oy', 'ab', 'aps', 'pty',
    'pvt', 'private', 'kg', 'group', 'holdings', 'the', 'official',
]);

export function normalizeName(name) {
    if (!name) return '';
    return String(name)
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/['’`]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter((t) => t && !LEGAL_SUFFIXES.has(t))
        .join(' ');
}

/** Returns a similarity between 0 and 1 for two business names. */
export function nameSimilarity(a, b) {
    const na = normalizeName(a);
    const nb = normalizeName(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    const ca = na.replace(/\s+/g, '');
    const cb = nb.replace(/\s+/g, '');
    if (ca === cb) return 0.97;

    const ta = new Set(na.split(' '));
    const tb = new Set(nb.split(' '));
    const intersection = [...ta].filter((t) => tb.has(t)).length;
    const union = new Set([...ta, ...tb]).size;
    const jaccard = union ? intersection / union : 0;

    // "Allbirds" vs "Allbirds Australia": every token of the shorter name is present.
    const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
    const containsAll = [...small].every((t) => large.has(t));
    const containment = containsAll ? 0.8 + 0.1 * (small.size / large.size) : 0;

    // Compact prefix match, e.g. "gymshark" vs "gymsharkwomen".
    const prefix = (ca.length >= 5 && cb.startsWith(ca)) || (cb.length >= 5 && ca.startsWith(cb)) ? 0.75 : 0;

    return Math.max(jaccard, containment, prefix, levenshteinRatio(ca, cb) >= 0.9 ? 0.9 : 0);
}

export function levenshteinRatio(a, b) {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.5) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/** Cleans a website <title> into something that looks like a brand name. */
export function brandFromTitle(title) {
    if (!title) return null;
    const parts = String(title)
        .replace(/\s+/g, ' ')
        .split(/\s[|\-–—:·•]\s/)
        .map((p) => p.trim())
        .filter(Boolean);
    if (!parts.length) return null;
    // Titles are usually "Page – Brand" or "Brand | Tagline": the shortest part is most often the brand.
    const candidate = parts.reduce((best, p) => (p.length < best.length ? p : best), parts[0]);
    if (candidate.length < 2 || candidate.length > 60) return null;
    if (/^(home|homepage|welcome|official site|official website)$/i.test(candidate)) {
        return parts.find((p) => p !== candidate) ?? null;
    }
    return candidate;
}

export function truncate(text, max = 300) {
    if (text == null) return null;
    const s = String(text).replace(/\s+/g, ' ').trim();
    if (!s) return null;
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
