// "Ad strength": how likely an ad is a winner, inferred from public behaviour.
//
// Nobody outside an ad account can see conversions. What can be seen is how
// advertisers treat their ads: winners keep running, get duplicated into more
// ad sets ("copies") and spread across placements; losers get switched off.
// The longevity signal is only trustworthy when the account is actively managed.
// In a "set and forget" account an old ad can just as well be a neglected loser,
// so longevity is discounted there.

const DAY = 86400_000;

/**
 * Classifies how actively an advertiser manages its Meta ads.
 * `ads` are parsed Meta ads with `startDate`.
 */
export function accountActivity(ads, { windowDays, now = Date.now() }) {
    const starts = ads.map((a) => Date.parse(a.startDate)).filter(Number.isFinite);
    if (!starts.length) return { status: 'unknown', daysSinceLastNewAd: null, adsStartedInWindow: 0, adsAnalyzed: ads.length };
    const newest = Math.max(...starts);
    const daysSinceLastNewAd = Math.max(0, Math.floor((now - newest) / DAY));
    const startedInWindow = starts.filter((t) => t >= now - windowDays * DAY).length;
    let status = 'steady';
    if (daysSinceLastNewAd >= 90) status = 'static';
    else if (startedInWindow >= 3 || (starts.length >= 4 && startedInWindow / starts.length >= 0.3)) status = 'active_testing';
    return { status, daysSinceLastNewAd, adsStartedInWindow: startedInWindow, adsAnalyzed: ads.length };
}

const DYNAMISM_WEIGHT = { active_testing: 1, steady: 0.85, static: 0.5, unknown: 0.75 };

export function strengthLabel(score) {
    if (score >= 70) return 'proven';
    if (score >= 50) return 'promising';
    if (score >= 30) return 'testing';
    return 'unproven';
}

/**
 * Scores one ad from 0 to 100 and explains why.
 * ctx = { activity, reachValues (EU reach of the advertiser's ads), now }
 */
export function scoreAd(ad, { activity = 'unknown', reachValues = [], now = Date.now() } = {}) {
    const reasons = [];
    const start = Date.parse(ad.startDate);
    const days = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / DAY)) : null;

    // Longevity (0-45): under a week is too new to judge.
    let longevity = 0;
    if (days != null && days >= 7) {
        longevity = 45 * Math.min(1, Math.log(days / 7 + 1) / Math.log(120 / 7 + 1));
        reasons.push(`Running ${days} days`);
    } else if (days != null) {
        reasons.push(`Only ${days} day${days === 1 ? '' : 's'} old: too new to judge`);
    }
    const weight = DYNAMISM_WEIGHT[activity] ?? DYNAMISM_WEIGHT.unknown;
    if (weight < 1 && longevity > 10 && activity === 'static') {
        reasons.push('Account launches no new ads, so age says less about performance');
    }
    longevity *= weight;

    // Scaling (0-25): Meta groups identical creatives; many copies = being scaled.
    const copies = Math.max(1, ad.collationCount ?? 1);
    const scaling = 25 * Math.min(1, Math.log2(copies) / Math.log2(10));
    if (copies > 1) reasons.push(`Duplicated into ${copies} ads`);

    // Distribution (0-10)
    const placements = new Set((ad.publisherPlatforms ?? []).map((p) => String(p).toUpperCase())).size;
    const distribution = [0, 2, 5, 7, 10][Math.min(4, placements)];
    if (placements >= 3) reasons.push(`Runs on ${placements} placements`);

    // EU reach (0-20) when known: relative to the advertiser's other ads, else absolute.
    let reachPoints = 0;
    const hasReach = Number.isFinite(ad.euTotalReach) && ad.euTotalReach > 0;
    if (hasReach) {
        const others = reachValues.filter((v) => Number.isFinite(v) && v > 0);
        if (others.length >= 3) {
            const below = others.filter((v) => v < ad.euTotalReach).length;
            const percentile = below / others.length;
            reachPoints = 20 * percentile;
            if (percentile >= 0.75) reasons.push(`EU reach ${compact(ad.euTotalReach)}, among this advertiser's top ${Math.max(1, Math.round((1 - percentile) * 100))}%`);
        } else {
            reachPoints = 20 * Math.min(1, Math.log10(ad.euTotalReach) / 6);
            reasons.push(`EU reach ${compact(ad.euTotalReach)}`);
        }
    }

    const max = 80 + (hasReach ? 20 : 0);
    const score = Math.round((100 * (longevity + scaling + distribution + reachPoints)) / max);
    return { score, label: strengthLabel(score), daysRunning: days, copies, reasons };
}

/** Scores all ads of an advertiser and summarizes. */
export function analyzeAdStrength(ads, { windowDays, now = Date.now() }) {
    const activity = accountActivity(ads, { windowDays, now });
    const reachValues = ads.map((a) => a.euTotalReach);
    const scored = ads.map((ad) => ({ ad, strength: scoreAd(ad, { activity: activity.status, reachValues, now }) }))
        .sort((a, b) => b.strength.score - a.strength.score);
    const counts = { proven: 0, promising: 0, testing: 0, unproven: 0 };
    for (const s of scored) counts[s.strength.label]++;
    return {
        activity,
        scored,
        summary: {
            accountActivity: activity.status,
            daysSinceLastNewAd: activity.daysSinceLastNewAd,
            adsScored: scored.length,
            topAdStrength: scored[0]?.strength.score ?? null,
            provenAds: counts.proven,
            promisingAds: counts.promising,
            testingAds: counts.testing,
            unprovenAds: counts.unproven,
        },
    };
}

export function compact(n) {
    if (!Number.isFinite(n)) return String(n);
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
    return String(Math.round(n));
}
