# Is This Business Running Ads? Facebook, Instagram, Google & LinkedIn Ad Checker

Paste a list of companies, domains or Facebook pages and find out in one run:

- **Are they running ads right now** on **Facebook & Instagram** (Meta Ad Library), **Google Search, YouTube, Display & Shopping** (Google Ads Transparency Center) and **LinkedIn** (LinkedIn Ad Library)?
- **How many** active ads, since when, on which placements, and with what copy, calls to action and landing pages.
- **Which ad pixels** are installed on their website: Meta Pixel, Google Ads tag, TikTok, LinkedIn Insight, Microsoft UET (Bing), Pinterest, Snap, X, Reddit, Criteo and more. This includes pixels loaded through **Google Tag Manager**, which most tech-stack tools miss.
- **Ad strength:** a 0-100 "winning ad" score for every live Meta ad, and whether the account is actively managed or "set and forget".
- **EU reach and a modelled monthly ad spend range (EUR)** for ads shown in the EU, built from the reach and impression data platforms must publish under the Digital Services Act.
- **A 0-100 advertiser score**, sales-ready **opportunity signals** and a **personalized first line** for cold outreach.
- **What changed** since the last run (started or stopped advertising, new or switched-off ads, new pixels) when you run it on a schedule.

No login and no cookies. It only uses the public ad transparency libraries. One optional API token (Meta's free Ad Library API) unlocks Meta EU reach data.

## Who uses it

| You are... | You use it to... |
| --- | --- |
| **A marketing agency or freelancer** | Find prospects who already spend on ads (proven budget), or who have a pixel installed but nothing live (lapsed advertisers). |
| **A lead-gen or outbound team (Clay, Apollo, Instantly)** | Enrich lead lists with "is advertising: yes/no", ad counts and a ready-made icebreaker. |
| **A SaaS or ad-tech company** | Qualify accounts by paid-media activity before sales outreach. |
| **A brand or growth team** | Monitor competitors and get alerted when they launch, scale or pause campaigns. |
| **An investor or analyst** | Check go-to-market intensity across a portfolio or market map. |

## What makes it different

- **One verdict across platforms.** Most Store tools scrape *one* ad library and return hundreds of rows of raw ads. This Actor returns **one decision-ready row per business**.
- **Accurate matching, not keyword guessing.** Searching the Meta Ad Library by name returns resellers, fan pages and namesakes. This Actor finds the business's **official Facebook page from its own website**, or attributes ads by their **landing-page domain**, and tells you how it matched (`matchMethod`, `matchConfidence`).
- **Pixels inside Tag Manager.** GTM and gtag containers are downloaded and inspected, so a Meta Pixel or Google Ads tag that is not visible in the page HTML is still found.
- **Honest ad intelligence.** Sales and conversions are private to every advertiser, so this Actor never pretends to know them. Ad strength is built from what is public (ad age, duplication, placements, EU reach), and spend is always a **range with its assumptions printed next to it**.
- **Fair billing.** You are charged per business checked, and **never for checks that fail**.
- **Built for automation.** Your own fields (CRM IDs and so on) are passed through unchanged, and the output is flat enough for Clay, Make, Zapier, n8n and spreadsheets.

## How to use it

1. Add businesses to **Businesses to check**, one per line. Any of these works:
    - `allbirds.com`
    - `https://www.allbirds.com/collections/mens`
    - `Allbirds`
    - `https://www.facebook.com/allbirds`
    - `Allbirds | allbirds.com` (name and domain together give the best accuracy)
2. Choose platforms and a country (or keep **All countries**).
3. Click **Start**. Each business appears in the dataset as soon as it is checked.

**Got a lead list from another Actor?** Put its dataset ID in **Import from another Actor's dataset**. Output from **Google Maps Scraper** and **Website Contact Scraper** is recognized automatically. Scrape *"dentists in Austin"*, then see which ones advertise.

## Output

Each business becomes one row. Example (illustrative, shortened):

```json
{
  "businessName": "Allbirds",
  "domain": "allbirds.com",
  "isRunningAds": true,
  "verdict": "RUNNING_ADS",
  "confidence": "high",
  "activePlatforms": ["meta", "google"],
  "totalActiveAds": 187,
  "advertiserScore": 91,
  "adIntensity": "high",
  "adStrength": { "accountActivity": "active_testing", "daysSinceLastNewAd": 2, "topAdStrength": 92, "provenAds": 7, "promisingAds": 11, "adsScored": 50 },
  "euReach": 4100000,
  "estimatedMonthlySpendEur": { "low": 18000, "high": 95000, "tier": "large", "platforms": ["meta"], "scope": "EU-delivered ads only", "confidence": "low", "disclaimer": "Modelled estimate, not actual spend. ..." },
  "signalCodes": ["WINNING_CREATIVES", "LONG_RUNNING_CREATIVES", "BIG_EU_SPENDER", "ECOMMERCE_STORE"],
  "outreachSnippet": "Your oldest live Meta ad has been running for 214 days, which usually means it's working. Are you testing new creative against it?",
  "facebookPageUrl": "https://www.facebook.com/allbirds/",
  "meta": {
    "isRunningAds": true,
    "activeAdsCount": 140,
    "matchMethod": "facebook_page_html:delegate_page",
    "matchConfidence": "high",
    "pageId": "...",
    "pageName": "Allbirds",
    "adsStartedInWindow": 12,
    "oldestActiveAdStartDate": "2026-03-27T07:00:00.000Z",
    "longestRunningAdDays": 214,
    "publisherPlatforms": ["FACEBOOK", "INSTAGRAM", "MESSENGER", "AUDIENCE_NETWORK"],
    "topCallsToAction": ["Shop now", "Learn more"],
    "landingDomains": ["allbirds.com"],
    "sampleAds": [{
      "adArchiveId": "...", "startDate": "...", "daysRunning": 214, "copies": 9,
      "strength": 92, "strengthLabel": "proven",
      "strengthReasons": ["Running 214 days", "Duplicated into 9 ads", "Runs on 4 placements", "EU reach 610k, among this advertiser's top 5%"],
      "euReach": 610000, "body": "...", "ctaText": "Shop now", "linkUrl": "https://www.allbirds.com/...", "adLibraryUrl": "https://www.facebook.com/ads/library/?id=..."
    }],
    "euTransparency": {
      "source": "meta_ad_library_api", "adsWithEuReach": 38, "totalEuReach": 4100000,
      "topCountries": [{ "country": "DE", "reach": 1500000, "share": 0.37 }],
      "audience": { "genderSplit": { "male": 0.41, "female": 0.58, "unknown": 0.01 }, "topAgeRanges": [{ "range": "25-34", "share": 0.34 }] },
      "payers": ["Allbirds, Inc."], "likelyAgencyPayer": null
    },
    "spendEstimate": { "lifetime": { "low": "...", "high": "..." }, "monthly": { "low": "...", "high": "..." }, "coverage": 0.76, "assumptions": { "frequency": [1.4, 2.6], "cpmEur": "weighted by EU country tier ..." } },
    "adLibraryUrl": "https://www.facebook.com/ads/library/?...&view_all_page_id=..."
  },
  "google": {
    "isRunningAds": true,
    "advertiserName": "Allbirds, Inc.",
    "activeCreativesInWindow": 47,
    "lastShownDate": "2026-10-26T00:00:00.000Z",
    "formats": { "TEXT": 20, "IMAGE": 11, "VIDEO": 16 },
    "transparencyUrl": "https://adstransparency.google.com/advertiser/AR..."
  },
  "linkedin": { "isRunningAds": false, "adsFound": 0 },
  "website": {
    "adPixels": ["metaPixel", "googleAds", "tiktokPixel", "pinterestTag"],
    "adPixelDetails": { "metaPixel": { "ids": ["..."], "foundIn": ["GTM-XXXX"] } },
    "analytics": ["ga4", "gtm"],
    "ecommercePlatform": "Shopify",
    "marketingTools": ["klaviyo"],
    "socialProfiles": { "facebook": "...", "instagram": "...", "tiktok": "..." }
  },
  "inputRecord": { "id": "your-crm-id-123" },
  "checkedAt": "2026-10-27T15:00:00.000Z"
}
```

The dataset has five ready-made views: **Overview**, **Ad intelligence**, **Platform details**, **Pixels & tech stack** and **Changes (monitoring)**. Export them as CSV, Excel or JSON, or read them through the API.

### Verdicts

| `verdict` | Meaning |
| --- | --- |
| `RUNNING_ADS` | Live ads were found on at least one platform. |
| `NOT_RUNNING_ADS` | Every checked platform answered, no live ads were found, and no ad pixels were detected. |
| `AD_PIXELS_ONLY` | No live ads, but ad pixels are installed: a past, paused or retargeting-only advertiser. |
| `INCONCLUSIVE` | The platforms could not be checked (for example, blocked). You are not charged. |

### Opportunity signals

| Code | What it tells you |
| --- | --- |
| `META_PIXEL_NO_ACTIVE_ADS` | Meta Pixel installed, no live Meta ads: a lapsed or paused advertiser. |
| `GOOGLE_TAG_NO_ACTIVE_ADS` | Google Ads tag installed, no Google ads in the activity window. |
| `META_ADS_WITHOUT_PIXEL` | Spending on Meta, but no Meta Pixel detected (or server-side only). |
| `GOOGLE_ADS_WITHOUT_CONVERSION_TAG` | Spending on Google, but no Google Ads conversion or remarketing tag detected. |
| `SINGLE_CHANNEL` | Advertises on Meta *or* Google, not both: a cross-channel opportunity. |
| `LONG_RUNNING_CREATIVES` | Oldest live Meta ad is 90+ days old in an actively managed account: likely a winner, or creative fatigue. |
| `SET_AND_FORGET` | No new Meta ad launched in 90+ days and the same creatives keep running: the account looks unmanaged. One of the best agency pitches. |
| `WINNING_CREATIVES` | At least one live Meta ad scores 70+ on ad strength. |
| `AGENCY_MANAGED` | The ads are paid for by a different company (from EU payer data), usually an agency or reseller. |
| `BIG_EU_SPENDER` | Modelled EU spend is in the `large` or `very_large` tier. |
| `LOW_CREATIVE_VOLUME` | 1-3 live Meta ads: little creative testing. |
| `SCALING_NOW` | Most live Meta ads started within the activity window. |
| `B2B_ADVERTISER` | Runs LinkedIn ads. |
| `ECOMMERCE_STORE` | Shopify, WooCommerce, BigCommerce, Magento, Wix, Squarespace or Webflow store. |
| `NO_ADS_NO_TRACKING` | Not advertising and no ad pixels: a greenfield prospect. |

## Ad strength, EU reach and spend estimates

**Can it tell you how many sales an ad makes?** No, and neither can any outside tool. Sales and conversions exist only inside the advertiser's own ad account. What *is* public is how advertisers treat their ads, plus the reach data the EU forces platforms to publish. This Actor turns those into two clearly labelled estimates.

### Ad strength (every live Meta ad, all countries)

Advertisers switch off ads that lose money and keep, duplicate and widen the ones that work. Each ad gets a 0-100 score:

| Component | Weight | Why |
| --- | --- | --- |
| Days running | up to 45 | Survivors are usually profitable. Ads under 7 days old are "too new to judge". |
| Copies (identical ads Meta groups together) | up to 25 | One creative running as 10 copies is being scaled. |
| Placements (Facebook, Instagram, Messenger, Audience Network...) | up to 10 | Winners get rolled out wider. |
| EU reach, relative to the advertiser's other ads | up to 20 | Only when EU data exists; otherwise the score is rescaled without it. |

Labels: `proven` (70+), `promising` (50-69), `testing` (30-49), `unproven` (<30). Every score comes with `strengthReasons`.

**The set-and-forget correction:** an old ad only means "winner" if someone is managing the account. When an advertiser hasn't launched a new ad in 90+ days (`accountActivity: "static"`), ad age counts for half, and the `SET_AND_FORGET` signal fires instead of `LONG_RUNNING_CREATIVES`. Many small businesses leave a losing ad running for a year, and this keeps them from being labelled "proven".

### EU reach and modelled spend (EU-delivered ads only)

Under the Digital Services Act, platforms publish **reach** (Meta) and **impression ranges** (LinkedIn) for ads shown in the EU. The Actor models a spend range:

- Meta: `EU reach × frequency (1.4-2.6) × CPM`, where the CPM is weighted by EU country (about €5-12 in DE/FR/NL/Nordics, €3-8 in ES/IT/PT, €1.5-5 in PL/RO/HU/BG/HR; €3-11 when the country mix is unknown)
- LinkedIn: `impression range × CPM (€25-70)`

You get lifetime and monthly run-rate ranges per platform, rounded to two significant figures. When only some ads had data, an extrapolated range is added, together with `coverage` and a `confidence` of `low` or `very_low`. **Treat it as an order of magnitude, not a number to quote to a client.** If you know real CPMs for your market, pass them in **Your own CPM assumptions** (for example `{"meta": [6, 14], "linkedin": [30, 60]}`).

**Getting Meta EU reach:** Meta publishes EU reach, the country/age/gender breakdown and the ad's payer through its free official Ad Library API. Confirm your identity at facebook.com/ID, create an app at developers.facebook.com, generate a user access token, and paste it into **Meta Ad Library API token** (stored encrypted). Short-lived tokens expire within hours, so exchange yours for a long-lived one (about 60 days) for scheduled runs. Without a token, Meta EU reach is usually unavailable, but ad strength still works everywhere.

## Monitoring and alerts

1. Turn on **Enable change monitoring** and give each list its own **Monitoring state store name**.
2. Turn on **Output only businesses that changed**.
3. Create a **Schedule** (for example, daily or weekly) in Apify Console.
4. Add an **Integration** (Slack, email or webhook) that fires when the run succeeds.

Each change row includes `change.status` (`STARTED_ADVERTISING`, `STOPPED_ADVERTISING`, `NEW_PLATFORM`, `LEFT_PLATFORM`, `NEW_ADS`, `PIXELS_CHANGED`) and a human-readable `change.summary`. `change.stoppedMetaAds` counts ads switched off since the last run (when both runs saw every live ad). Which ads survive week after week is the strongest public signal of what works. A platform that is temporarily blocked keeps its previous state, so you do not get false "stopped advertising" alerts. If every check for a business fails, you get a `CHECK_FAILED` row instead of silence, so a broken monitor never goes unnoticed.

## Integrations

- **Clay:** add an HTTP API enrichment that calls the [run-sync-get-dataset-items](https://docs.apify.com/api/v2/act-run-sync-get-dataset-items-post) endpoint with `{"businessRecords":[{"name":"{{Company}}","domain":"{{Domain}}","id":"{{Row ID}}"}]}`, then map `isRunningAds`, `totalActiveAds` and `outreachSnippet` into columns.
- **Make, Zapier, n8n:** use the official Apify app ("Run an Actor", then "Get dataset items").
- **AI agents:** the Actor is available as a tool through the [Apify MCP server](https://docs.apify.com/platform/integrations/mcp), so an agent can ask "is acme.com running ads?" and get a structured answer.
- **API, Python and JavaScript:** see the **API** tab of this Actor.

## Pricing

Pay per event: you pay only for results.

| Event | When it is charged |
| --- | --- |
| `business-checked` | Once per business where at least one check (website, Google, LinkedIn or Meta) succeeded. |
| `meta-ads-checked` | Once per business whose Meta Ad Library check succeeded. This is the expensive one: a real browser plus residential proxies. |
| `eu-insights` | Once per business where EU reach, LinkedIn impression data or a spend estimate was actually returned. Never charged when no EU data exists. |

Turn off **Check Meta** if you only need Google, LinkedIn and pixels. If you set a **maximum cost per run**, the Actor checks only as many businesses as fit in it. See the **Pricing** tab for current prices.

## Accuracy notes and limitations

- **Meta** reports ads that are **active right now**. When the Facebook page is known (from your input or from the website), matching is reliable. Name-only lookups are verified against landing-page domains and page names, and anything uncertain is reported as `low` confidence rather than guessed.
- **Google** reports advertisers verified in the Ads Transparency Center. An ad counts as running if it was **shown within the activity window** (30 days by default). Lookups by domain are the most reliable.
- **LinkedIn**: only the first page of results (about 24 ads) is read, so `adsFound` can be a lower bound (`countIsLowerBound: true`).
- **Pixels** are detected on the homepage and in its tag manager containers. Pixels fired only on later pages, behind a consent banner or server-side (Conversions API) are not visible from the outside.
- **Sales and conversions** are not available from any public source, and this Actor does not output them.
- **Spend** is a model, not a measurement: it covers only EU-delivered ads, uses benchmark CPMs, and can be off by several times. Ads that never reached the EU have no spend estimate at all.
- **Ad strength** is inferred from behaviour. A new account that just launched its best ad will score it low until the ad has had time to prove itself.
- **TikTok and Microsoft** ad libraries cover only ads shown in the EU and are not included yet. The TikTok, Microsoft (UET) and other pixels on the website are detected.

## FAQ

**Is this legal?** The Actor reads only public, logged-out transparency libraries that the platforms publish so that anyone can see who is advertising. It does not log in or collect personal data. You are responsible for how you use the results, for example under GDPR and CAN-SPAM in outreach.

**Why is a business `INCONCLUSIVE`?** The ad libraries sometimes block traffic. Keep the residential proxy for Meta (the default) and re-run only the inconclusive rows. You were not charged for them.

**Why does Meta say 0 ads when I can see their ads?** Check `meta.matchMethod`. If it is `keyword_search`, no official page was found. Add the Facebook page URL (`Name | domain.com | https://facebook.com/page`) or enable website discovery and run it again.

**How fast is it?** Website, Google and LinkedIn checks take a few seconds per business and run in parallel. The Meta browser check is slower (a real browser, typically 10-20 seconds per business) and runs three at a time by default. Raise **Max concurrency (Meta browser pages)** and memory for big lists.

## Feedback

Found a wrong verdict? Open an issue with the business and the `meta.adLibraryUrl` / `google.transparencyUrl` from the output, and it will be fixed quickly. Feature requests are welcome too.
