// Change detection between runs. Snapshots live in a named key-value store,
// so they survive across runs and schedules.
//
// A platform that errored in this run keeps its previous state. Otherwise a
// temporary block would fire a false "stopped advertising" alert.

import { createHash } from 'node:crypto';

const PLATFORMS = ['meta', 'google', 'linkedin'];

export function monitorKey(businessKey) {
    return `biz-${createHash('sha1').update(businessKey).digest('hex').slice(0, 32)}`;
}

/**
 * `metaAds` is [{ id, start }] for the live Meta ads analyzed in this run;
 * `metaAdsComplete` says whether that list covers every live ad.
 */
export function buildSnapshot(record, { metaAds = [], metaAdsComplete = false, previous = null }) {
    const platforms = {};
    for (const p of PLATFORMS) {
        const r = record[p];
        if (!r?.checked) continue;
        if (r.error) {
            if (previous?.platforms?.[p]) platforms[p] = { ...previous.platforms[p], carriedOver: true };
            continue;
        }
        platforms[p] = { isRunningAds: Boolean(r.isRunningAds), count: countFor(p, r) };
    }
    const metaOk = record.meta?.checked && !record.meta.error;
    return {
        checkedAt: record.checkedAt,
        platforms,
        isRunningAds: Object.values(platforms).some((x) => x.isRunningAds),
        metaAds: metaOk ? metaAds.slice(0, 500) : (previous?.metaAds ?? []),
        metaAdsComplete: metaOk ? Boolean(metaAdsComplete) && metaAds.length <= 500 : Boolean(previous?.metaAdsComplete),
        adPixels: record.website?.reachable ? record.website.adPixels : (previous?.adPixels ?? []),
    };
}

function countFor(platform, r) {
    if (platform === 'meta') return r.activeAdsCount ?? 0;
    if (platform === 'google') return r.activeCreativesInWindow ?? 0;
    return r.adsFound ?? 0;
}

export function diffSnapshots(prev, cur) {
    if (!prev) {
        return {
            status: 'FIRST_CHECK',
            summary: 'First monitored check. Changes will be reported from the next run.',
            previousCheckedAt: null,
            startedOn: [],
            stoppedOn: [],
            newMetaAds: 0,
            stoppedMetaAds: null,
            adCountDelta: 0,
            newAdPixels: [],
            removedAdPixels: [],
        };
    }
    const wasOn = (p) => Boolean(prev.platforms?.[p]?.isRunningAds);
    const isOn = (p) => Boolean(cur.platforms?.[p]?.isRunningAds);
    const known = PLATFORMS.filter((p) => prev.platforms?.[p] && cur.platforms?.[p]);
    const startedOn = known.filter((p) => !wasOn(p) && isOn(p));
    const stoppedOn = known.filter((p) => wasOn(p) && !isOn(p));
    const sum = (snap) => known.reduce((s, p) => s + (snap.platforms[p].count ?? 0), 0);
    const adCountDelta = sum(cur) - sum(prev);

    // Only a sample of ads is analyzed per run, so "new" means: not seen before AND
    // started after the previous check (Meta start dates are day-granular, hence 1 day slack).
    const prevIds = new Set((prev.metaAds ?? []).map((a) => a.id));
    const since = Date.parse(prev.checkedAt ?? '') - 86400_000;
    const newMetaAds = prev.platforms?.meta && Number.isFinite(since)
        ? (cur.metaAds ?? []).filter((a) => !prevIds.has(a.id) && Date.parse(a.start ?? '') >= since).length
        : 0;
    // Switched-off ads can only be counted when both runs saw every live ad.
    const curIds = new Set((cur.metaAds ?? []).map((a) => a.id));
    const stoppedMetaAds = prev.metaAdsComplete && cur.metaAdsComplete
        ? (prev.metaAds ?? []).filter((a) => !curIds.has(a.id)).length
        : null;
    const prevPixels = new Set(prev.adPixels ?? []);
    const curPixels = new Set(cur.adPixels ?? []);
    const newAdPixels = [...curPixels].filter((p) => !prevPixels.has(p));
    const removedAdPixels = [...prevPixels].filter((p) => !curPixels.has(p));

    let status = 'NO_CHANGE';
    const parts = [];
    if (!prev.isRunningAds && cur.isRunningAds) status = 'STARTED_ADVERTISING';
    else if (prev.isRunningAds && !cur.isRunningAds) status = 'STOPPED_ADVERTISING';
    else if (startedOn.length) status = 'NEW_PLATFORM';
    else if (stoppedOn.length) status = 'LEFT_PLATFORM';
    else if (newMetaAds > 0) status = 'NEW_ADS';
    else if (newAdPixels.length || removedAdPixels.length) status = 'PIXELS_CHANGED';

    if (startedOn.length) parts.push(`started on ${startedOn.join(', ')}`);
    if (stoppedOn.length) parts.push(`stopped on ${stoppedOn.join(', ')}`);
    if (newMetaAds) parts.push(`${newMetaAds} new Meta ad${newMetaAds === 1 ? '' : 's'}`);
    if (stoppedMetaAds) parts.push(`${stoppedMetaAds} Meta ad${stoppedMetaAds === 1 ? '' : 's'} switched off`);
    if (adCountDelta) parts.push(`active ads ${adCountDelta > 0 ? '+' : ''}${adCountDelta}`);
    if (newAdPixels.length) parts.push(`new pixels: ${newAdPixels.join(', ')}`);
    if (removedAdPixels.length) parts.push(`removed pixels: ${removedAdPixels.join(', ')}`);

    return {
        status,
        summary: parts.length ? capitalize(parts.join('; ')) : 'No change since the previous check.',
        previousCheckedAt: prev.checkedAt ?? null,
        startedOn,
        stoppedOn,
        newMetaAds,
        stoppedMetaAds,
        adCountDelta,
        newAdPixels,
        removedAdPixels,
    };
}

function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
