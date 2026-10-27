// Fingerprints for ad pixels and the marketing stack.
//
// `patterns` mark a technology as present. `ids` (global regexes with one
// capture group) pull out account or pixel IDs, which let you check whether
// two sites share one ad account. GTM container code is matched with the
// same rules after unescaping, plus GTM built-in tag type names (`__awct`...).

/** @typedef {{ key: string, label: string, platform?: string, patterns: RegExp[], ids?: RegExp[], idPrefix?: string }} Signature */

/** @type {Signature[]} */
export const AD_PIXELS = [
    {
        key: 'metaPixel',
        label: 'Meta Pixel',
        platform: 'meta',
        patterns: [
            /connect\.facebook\.net\/[\w-]+\/fbevents\.js/i,
            /fbq\(\s*['"]init['"]/i,
            /facebook\.com\/tr\/?\?id=\d/i,
            /"vtp_pixelId"/i,
        ],
        ids: [
            /fbq\(\s*['"]init['"]\s*,\s*['"]?(\d{10,20})/gi,
            /facebook\.com\/tr\/?\?id=(\d{10,20})/gi,
            /"vtp_pixelId"\s*:\s*"(\d{10,20})"/gi,
        ],
    },
    {
        key: 'googleAds',
        label: 'Google Ads tag',
        platform: 'google',
        patterns: [
            /\bAW-\d{8,12}\b/,
            /googleadservices\.com\/pagead\/conversion/i,
            /googleads\.g\.doubleclick\.net\/pagead/i,
            /"function"\s*:\s*"__(?:awct|sp|awcc|awud|gclidw)"/,
        ],
        ids: [/\b(AW-\d{8,12})\b/g, /"vtp_conversionId"\s*:\s*"(\d{8,12})"/g],
        idPrefix: 'AW-',
    },
    {
        key: 'googleFloodlight',
        label: 'Google Floodlight (Campaign Manager / DV360)',
        platform: 'google',
        patterns: [/fls\.doubleclick\.net/i, /\bDC-\d{6,10}\b/, /"function"\s*:\s*"__(?:flc|fls)"/],
        ids: [/\b(DC-\d{6,10})\b/g],
    },
    {
        key: 'tiktokPixel',
        label: 'TikTok Pixel',
        platform: 'tiktok',
        patterns: [/analytics\.tiktok\.com\/i18n\/pixel/i, /\bttq\.load\(/],
        ids: [/ttq\.load\(\s*['"]([A-Z0-9]{15,25})['"]/g, /sdkid=([A-Z0-9]{15,25})/g],
    },
    {
        key: 'linkedinInsight',
        label: 'LinkedIn Insight Tag',
        platform: 'linkedin',
        patterns: [/snap\.licdn\.com\/li\.lms-analytics/i, /_linkedin_partner_id/, /px\.ads\.linkedin\.com/i, /"function"\s*:\s*"__bzi"/],
        ids: [/_linkedin_partner_id\s*=\s*['"]?(\d{4,10})/g, /"function"\s*:\s*"__bzi"[^}]{0,200}?"vtp_id"\s*:\s*"(\d{4,10})"/g],
    },
    {
        key: 'microsoftUet',
        label: 'Microsoft Advertising UET (Bing Ads)',
        platform: 'microsoft',
        patterns: [/bat\.bing\.com\/bat\.js/i, /\buetq\b/, /"function"\s*:\s*"__baut"/],
        ids: [/\bti\s*:\s*['"]?(\d{6,10})/g, /"vtp_tagId"\s*:\s*"(\d{6,10})"/g],
    },
    {
        key: 'pinterestTag',
        label: 'Pinterest Tag',
        platform: 'pinterest',
        patterns: [/s\.pinimg\.com\/ct\/core\.js/i, /pintrk\(\s*['"]load['"]/, /ct\.pinterest\.com\/v3/i],
        ids: [/pintrk\(\s*['"]load['"]\s*,\s*['"](\d{10,16})['"]/g, /ct\.pinterest\.com\/v3\/\?[^"']*tid=(\d{10,16})/g],
    },
    {
        key: 'snapPixel',
        label: 'Snap Pixel',
        platform: 'snapchat',
        patterns: [/sc-static\.net\/scevent\.min\.js/i, /snaptr\(\s*['"]init['"]/],
        ids: [/snaptr\(\s*['"]init['"]\s*,\s*['"]([a-f0-9-]{36})['"]/gi],
    },
    {
        key: 'xPixel',
        label: 'X (Twitter) Pixel',
        platform: 'x',
        patterns: [/static\.ads-twitter\.com\/uwt\.js/i, /\btwq\(\s*['"](?:init|config)['"]/, /analytics\.twitter\.com\/i\/adsct/i, /"function"\s*:\s*"__twitter_website_tag"/],
        ids: [/twq\(\s*['"](?:init|config)['"]\s*,\s*['"]([a-z0-9]{5,10})['"]/gi],
    },
    {
        key: 'redditPixel',
        label: 'Reddit Pixel',
        platform: 'reddit',
        patterns: [/redditstatic\.com\/ads\/pixel\.js/i, /\brdt\(\s*['"]init['"]/],
        ids: [/rdt\(\s*['"]init['"]\s*,\s*['"]([at]2_[a-z0-9]+)['"]/gi],
    },
    {
        key: 'quoraPixel',
        label: 'Quora Pixel',
        platform: 'quora',
        patterns: [/a\.quora\.com\/qevents\.js/i, /\bqp\(\s*['"]init['"]/, /"function"\s*:\s*"__qpx"/],
        ids: [/qp\(\s*['"]init['"]\s*,\s*['"]([a-f0-9]{32})['"]/gi],
    },
    {
        key: 'criteo',
        label: 'Criteo OneTag',
        platform: 'criteo',
        patterns: [/static\.criteo\.net\/js\/ld\/ld\.js/i, /dynamic\.criteo\.com/i, /\bcriteo_q\b/, /"function"\s*:\s*"__crto"/],
    },
    {
        key: 'adroll',
        label: 'AdRoll',
        platform: 'adroll',
        patterns: [/s\.adroll\.com\/j\//i, /\badroll_adv_id\b/, /"function"\s*:\s*"__asp"/],
        ids: [/adroll_adv_id\s*=\s*['"]([A-Z0-9]{16,26})['"]/g],
    },
    {
        key: 'taboola',
        label: 'Taboola Pixel',
        platform: 'taboola',
        patterns: [/cdn\.taboola\.com\/libtrc\/unip/i, /\b_tfa\.push\(/],
    },
    {
        key: 'outbrain',
        label: 'Outbrain Pixel',
        platform: 'outbrain',
        patterns: [/amplify\.outbrain\.com\/cp\/obtp\.js/i, /\bobApi\(/],
    },
    {
        key: 'amazonAds',
        label: 'Amazon Ads tag',
        platform: 'amazon',
        patterns: [/c\.amazon-adsystem\.com/i, /s\.amazon-adsystem\.com\/iu3/i, /\bamzn\(\s*['"]addTag['"]/],
    },
    {
        key: 'stackadapt',
        label: 'StackAdapt Pixel',
        platform: 'stackadapt',
        patterns: [/tags\.srv\.stackadapt\.com/i, /\bsaq\(\s*['"]ts['"]/],
    },
];

/** @type {Signature[]} */
export const ANALYTICS = [
    { key: 'ga4', label: 'Google Analytics 4', patterns: [/googletagmanager\.com\/gtag\/js\?id=G-/i, /gtag\(\s*['"]config['"]\s*,\s*['"]G-/, /"function"\s*:\s*"__(?:gaawc|googtag)"/], ids: [/\b(G-[A-Z0-9]{6,12})\b/g] },
    { key: 'universalAnalytics', label: 'Universal Analytics (legacy)', patterns: [/google-analytics\.com\/analytics\.js/i, /\bUA-\d{4,10}-\d{1,4}\b/], ids: [/\b(UA-\d{4,10}-\d{1,4})\b/g] },
    { key: 'gtm', label: 'Google Tag Manager', patterns: [/googletagmanager\.com\/gtm\.js/i, /\bGTM-[A-Z0-9]{4,9}\b/], ids: [/\b(GTM-[A-Z0-9]{4,9})\b/g] },
    { key: 'segment', label: 'Segment', patterns: [/cdn\.segment\.com\/analytics\.js/i] },
    { key: 'hotjar', label: 'Hotjar', patterns: [/static\.hotjar\.com/i, /\bhjid\s*:/, /"function"\s*:\s*"__hjtc"/] },
    { key: 'clarity', label: 'Microsoft Clarity', patterns: [/clarity\.ms\/tag/i] },
    { key: 'mixpanel', label: 'Mixpanel', patterns: [/cdn\.mxpnl\.com/i, /mixpanel\.init\(/] },
    { key: 'heap', label: 'Heap', patterns: [/cdn\.heapanalytics\.com/i] },
    { key: 'triplewhale', label: 'Triple Whale', patterns: [/triplewhale\.(?:com|io)\//i, /\bTriplePixel\b/] },
    { key: 'northbeam', label: 'Northbeam', patterns: [/j\.northbeam\.io/i] },
];

/** @type {Signature[]} */
export const MARKETING_TOOLS = [
    { key: 'hubspot', label: 'HubSpot', patterns: [/js\.hs-scripts\.com/i, /js\.hsforms\.net/i, /js\.hs-analytics\.net/i] },
    { key: 'klaviyo', label: 'Klaviyo', patterns: [/static\.klaviyo\.com/i, /klaviyo\.com\/onsite/i] },
    { key: 'mailchimp', label: 'Mailchimp', patterns: [/chimpstatic\.com/i, /list-manage\.com/i] },
    { key: 'intercom', label: 'Intercom', patterns: [/widget\.intercom\.io/i, /js\.intercomcdn\.com/i] },
    { key: 'drift', label: 'Drift', patterns: [/js\.driftt\.com/i] },
    { key: 'marketo', label: 'Marketo', patterns: [/munchkin\.marketo\.net/i] },
    { key: 'pardot', label: 'Salesforce Pardot', patterns: [/pi\.pardot\.com/i] },
    { key: 'activecampaign', label: 'ActiveCampaign', patterns: [/trackcmp\.net/i] },
    { key: 'attentive', label: 'Attentive', patterns: [/cdn\.attn\.tv/i] },
    { key: 'postscript', label: 'Postscript', patterns: [/sdk\.postscript\.io/i] },
    { key: 'yotpo', label: 'Yotpo', patterns: [/staticw2\.yotpo\.com/i, /cdn-widgetsrepository\.yotpo\.com/i] },
    { key: 'calendly', label: 'Calendly', patterns: [/assets\.calendly\.com/i] },
    { key: 'callrail', label: 'CallRail (call tracking)', patterns: [/cdn\.callrail\.com/i] },
];

/** @type {Signature[]} */
export const ECOMMERCE_PLATFORMS = [
    { key: 'Shopify', label: 'Shopify', patterns: [/cdn\.shopify\.com/i, /\bShopify\.theme\b/, /myshopify\.com/i] },
    { key: 'WooCommerce', label: 'WooCommerce', patterns: [/\/plugins\/woocommerce\//i, /wc-ajax=/i, /\bwoocommerce_params\b/] },
    { key: 'BigCommerce', label: 'BigCommerce', patterns: [/cdn\d*\.bigcommerce\.com/i] },
    { key: 'Magento', label: 'Magento / Adobe Commerce', patterns: [/Magento_[A-Z]/, /mage\/cookies/i] },
    { key: 'Wix', label: 'Wix', patterns: [/static\.wixstatic\.com/i, /\bwix-code\b/i, /X-Wix-/i] },
    { key: 'Squarespace', label: 'Squarespace', patterns: [/static1\.squarespace\.com/i, /squarespace-cdn\.com/i] },
    { key: 'Webflow', label: 'Webflow', patterns: [/data-wf-site=/i, /assets\.website-files\.com/i, /cdn\.prod\.website-files\.com/i] },
    { key: 'PrestaShop', label: 'PrestaShop', patterns: [/\bvar prestashop\b/i, /\/modules\/ps_[a-z]/i] },
    { key: 'Salesforce Commerce Cloud', label: 'Salesforce Commerce Cloud', patterns: [/demandware\.static/i, /\/on\/demandware\.store\//i] },
    { key: 'WordPress', label: 'WordPress', patterns: [/\/wp-content\//i, /\/wp-includes\//i] },
];

export function matchSignatures(text, signatures) {
    const found = {};
    for (const sig of signatures) {
        if (!sig.patterns.some((re) => re.test(text))) continue;
        const ids = new Set();
        for (const re of sig.ids ?? []) {
            re.lastIndex = 0;
            for (const m of text.matchAll(re)) {
                if (!m[1]) continue;
                ids.add(sig.idPrefix && !m[1].startsWith(sig.idPrefix) ? `${sig.idPrefix}${m[1]}` : m[1]);
                if (ids.size >= 10) break;
            }
        }
        found[sig.key] = { label: sig.label, platform: sig.platform ?? null, ids: [...ids] };
    }
    return found;
}

/** GTM / gtag containers embed tag code as escaped JS strings. */
export function unescapeJs(text) {
    return text
        .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\\//g, '/')
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'");
}
