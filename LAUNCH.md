# Launch playbook: hosting, pricing and selling this Actor on Apify

This is the operator's guide. `README.md` is the customer-facing Store page.

---

## 0. Reality check before anything else

| Part | Status |
| --- | --- |
| Input parsing, matching, scoring, signals, monitoring diff, billing guards | Covered by unit tests (`npm test`) |
| Meta crawler plumbing (navigation, GraphQL capture, waits, retries, multi-step flows, shutdown) | Covered by an end-to-end browser test against a fake Ad Library |
| Full pipeline (`main.js` → browser → ad strength → spend model → billing → dataset) | Covered by a pipeline test with pay-per-event simulated by the Apify SDK |
| Ad strength, spend model, Meta API client, LinkedIn detail parser | Unit tests with hand-computed values (Meta API shapes follow Meta's documented fields) |
| **Live** LinkedIn ad detail markup and real Meta API responses with a real token | **Not verified** |
| **Live response formats** of the Meta Ad Library, Google Transparency Center and LinkedIn Ad Library | **Not verified.** They were built from public reverse-engineering notes; the dev sandbox could not reach those sites |

**Do not publish until section 1 passes.** A scraper that returns wrong verdicts at launch collects 1-star reviews that you never recover from.

---

## 1. Validation gate (1-2 days)

1. Push the Actor privately (section 2) and run it with **30 businesses you have checked by hand**:
    - 10 heavy advertisers (for example Gymshark, Allbirds, HubSpot, Shopify, Canva, Monday.com, Grammarly, Airbnb, Nike, Calendly)
    - 10 small local businesses from a Google Maps search, a mix of advertisers and non-advertisers
    - 10 businesses that almost certainly do **not** advertise
2. Turn on **Include debug info** and compare every verdict with the public libraries yourself.
3. Pass criteria:
    - Meta verdict agrees with your manual check in **≥ 27 of 30** cases
    - Google verdict agrees in **≥ 27 of 30**
    - Fewer than **10%** `INCONCLUSIVE` with the default residential proxy
4. **EU insights check** (needs a Meta token, see README): run 10 advertisers known to target Germany/France and compare:
    - `meta.euTransparency.totalEuReach` with the "European Union transparency" panel of 3 ads in the Meta Ad Library UI
    - `linkedin.adDetails[].impressions` with the LinkedIn ad detail pages
    - If your agency knows a client's real EU spend, compare it with `estimatedMonthlySpendEur`. If it lands outside the range, adjust the default CPM tiers in `src/insights/spend.js` before launch.
5. If a platform fails, open a failing run, set **Include debug info**, and adjust the parser:
    - Meta: `src/platforms/meta-parse.js` (`collectFromDocuments`, `extractPageIdFromHtml`)
    - Google: `src/platforms/google.js` (field numbers in `parseCreative` and `parseSuggestions`)
    - LinkedIn: `src/platforms/linkedin.js` (`parseLinkedInSearch` selectors)
6. **Measure your real cost per business.** Open the run's **Usage** tab and record compute units (CU) and residential proxy GB:

```
cost per business = (CU × CU price + residential GB × GB price + datacenter cost) / businesses checked
```

Use the measured number, not the estimate in section 3, to set prices.

---

## 2. Deploy to Apify

### Option A: Apify CLI (fastest)

```bash
npm install -g apify-cli
apify login            # paste the API token from Console > Settings > Integrations
cd Ads-Checking-scrapper
apify push             # builds the Docker image on Apify and creates the Actor
```

### Option B: GitHub integration (recommended for ongoing work)

Console → **Actors** → **Develop new** → pick the **Git repository** source → choose this repo and branch. Then enable the GitHub webhook / auto-build so every push rebuilds the Actor.

### Actor settings (Console → your Actor → Settings)

| Setting | Value | Why |
| --- | --- | --- |
| Default memory | **4096 MB** | Chrome with three pages needs about 2-3 GB. Lower values cause out-of-memory crashes and bad reviews. |
| Default timeout | 3600 s | Large lists. Users can raise it. |
| Build tag | `latest` | |

Local development: `npm install`, then `npm test`, then `apify run --input '{"businesses":["acme.com"]}'`. Set `CHROMIUM_PATH` if Playwright's bundled browser is missing.

---

## 3. Monetization: pay per event

Console → Actor → **Publication** → **Monetization** → **Pay per event**. Create exactly these events (the names must match `src/main.js`):

| Event name | Title | Description | Suggested launch price |
| --- | --- | --- | --- |
| `business-checked` *(primary)* | Business checked | One business checked across the selected platforms and website. Not charged if every check failed. | **$0.005** |
| `meta-ads-checked` | Meta Ad Library check | Live Meta (Facebook/Instagram) ad lookup with a real browser. Only charged when it succeeds. | **$0.045** |
| `eu-insights` | EU reach & spend estimate | EU reach, LinkedIn impression data and a modelled EU spend range. Only charged when EU data was found. | **$0.01** |

Do **not** add the synthetic `apify-default-dataset-item` event. The code charges explicitly, and adding it would double-charge.

### Why these numbers (estimates; replace them with the section 1 measurements)

| Cost driver per business | Estimate |
| --- | --- |
| Meta: about 2 page loads × about 1.5 MB on residential proxy (about $8/GB) | ~$0.024 |
| Meta: 1-2 extra scrolls to analyze 50 ads for ad strength (`maxAdsToAnalyze`) | ~$0.004 |
| EU insights: Meta Graph API calls (no proxy) + up to 5 LinkedIn detail pages | ~$0.001 |
| Meta: browser compute (4 GB, about 8 s effective at concurrency 3) | ~$0.002 |
| Website, Google and LinkedIn over HTTP on datacenter proxy | ~$0.001 |
| **Total with Meta** | **~$0.031** |

Apify pays out **80% of event revenue**, and **under pay per event you pay the platform costs** (unless you choose "+ usage"). At $0.05 per business with Meta, you earn $0.040, the cost is about $0.031, and the margin is about $0.009 (**about 23%**). With EU insights ($0.06 in total) you earn $0.048 against about $0.032 (**about 33%**). If measured costs come in higher, cut `maxAdsToAnalyze` to 30 before you raise prices. Without Meta, you earn $0.004 against about $0.001 of cost.

How that compares for a customer: finding out whether a business advertises with a generic per-ad Meta scraper means scraping that business's ads, which costs about $0.01-0.17 per business on the Meta side alone (about 30 ads at $0.40-5.80 per 1,000), with no Google, LinkedIn, pixels or verdict. You are cheaper per decision and more complete.

**Pricing rules to respect:** price increases and new paid events count as *major changes*. They need a **14-day notice** and are limited to **once per month**. Launch at a price you can live with; lowering it later is easy, raising it is slow.

### Cutting costs (in order of impact)

1. The page-ID cache (already built): repeat and monitoring runs skip about one Meta page load per business.
2. Tiered proxies: try datacenter for Meta first and escalate to residential only on blocks (Apify `ProxyConfiguration` tiered config). Measure the block rate first.
3. Keep `.css`, images, video and fonts blocked (already done). Do not add scrolls beyond the current 3.

---

## 4. Store listing

| Field | Value |
| --- | --- |
| **Title** | `Is This Business Running Ads? Meta, Google & LinkedIn Ad Checker` |
| **Slug** | `is-this-business-running-ads` (alternatives: `ads-checker`, `ad-activity-checker`) |
| **Short description** (SEO) | Check if any company runs Facebook, Instagram, Google or LinkedIn ads. Active ad counts, ad pixels (incl. GTM), lead score, outreach line and change alerts. No login. |
| **Categories** | Lead generation, Marketing, Automation (plus AI if offered) |
| **Icon** | Simple: a megaphone with a magnifier or a checkmark. Avoid platform logos (trademarks). |
| **SEO keywords to use naturally** | facebook ad library checker, check if company runs ads, meta ads checker, google ads transparency scraper, competitor ads monitoring, ad pixel checker, lead enrichment |

**Prefill must stay fast and green.** Apify tests every public Actor **daily with the prefilled input**: the run must succeed and produce output within **5 minutes**, or the Actor is flagged. The current prefill (3 businesses) is sized for that, so do not add more.

**Add before launch:**

- A 60-90 second Loom or GIF: paste 5 Shopify domains, run, filter the `META_PIXEL_NO_ACTIVE_ADS` signal, export to CSV.
- 3 saved **example tasks** (Console → Tasks), made public:
    1. "Agency prospecting: Shopify stores"
    2. "Competitor monitor: weekly"
    3. "Google Maps leads: who advertises"

---

## 5. Go-to-market

**Positioning, in one line:** *"Know who is spending on ads before you pitch them."*

**Strongest hooks for agencies** (lead with these in posts and demos):
- **"Set-and-forget detector":** `SET_AND_FORGET` finds businesses still running the same ads after 90+ days with nothing new. That's an unmanaged account and the easiest pitch an agency gets.
- **"Already has an agency":** `AGENCY_MANAGED` (EU payer data) tells you who is paid by an agency. Skip them, or pitch a second opinion.
- **"Budget in euros, honestly labelled":** a modelled EU spend range per business, with its assumptions printed next to it. Never sell it as exact. The honesty is the differentiator against spy tools that print made-up revenue.

**Primary buyer:** performance marketing agencies and outbound teams. They have the pain (unqualified prospecting), the budget, and a repeatable volume of thousands of checks a month.

### Weeks 1-2: get the first 20 users

1. **Clay community:** "how do I check if a business is running ads" comes up again and again in its threads. Post a ready-to-use HTTP API column config (body template in the README) and reply to existing threads asking exactly this.
2. **Reddit:** r/PPC, r/agency, r/FacebookAds, r/coldemail, r/sales. Lead with a *data post*, not a pitch (see the next point).
3. **Data study as content:** run the Actor on 1,000 Shopify stores from a public list and publish, for example, "X% have a Meta Pixel but no live ads", "median live creatives", "% running Google but not Meta". Agencies share numbers like these. Only publish what the data actually says.
4. **LinkedIn:** post the study plus a short demo video. Tag nobody; let the numbers carry it.

### Weeks 3-6: compounding channels

5. **Chain with Google Maps Scraper**, one of the most-used Actors on the Store. Write the tutorial "Find local businesses that run Facebook ads in 3 steps" (scrape Maps, import the dataset ID, filter by `isRunningAds`). It ranks on Google and gets surfaced next to Maps users.
6. **Templates:** a Make scenario, an n8n workflow and a Zapier zap: "New HubSpot company → check ads → update property".
7. **AI agents:** the Actor is callable through the Apify MCP server. Write a short guide on asking Claude or ChatGPT "which of these 50 companies are running Meta ads?". It is a growing discovery channel.
8. **Apify affiliate and partner programs:** apply, and ask Apify to feature the Actor in their newsletter or blog once you have 30+ users and good reviews.

### Ongoing

9. Ask every happy user (the Issues tab, reruns ≥ 3) for a review. Store ranking weighs ratings and run success rate heavily.
10. Answer issues within 24 hours. Responsiveness is visible on the Store page and shapes trust.

---

## 6. Keep it working (the real long-term work)

Ad libraries change their internals every few weeks. Plan for it:

- **Canary schedule:** a private task that runs daily on 10 known heavy advertisers. Add a webhook alert when `runningAds` drops below 8, `inconclusive` goes above 2, or the run fails. You hear about breakage before customers do.
- **Changelog:** keep `CHANGELOG.md` and the Store changelog updated. It signals an actively maintained Actor.
- **Version bumps:** increase `version` in `.actor/actor.json` for breaking output changes. Keep existing output fields stable, because Clay and Zapier mappings break silently when fields move.

---

## 7. Metrics to watch (Console → your Actor → Insights / Analytics)

| Metric | Healthy target by month 3 |
| --- | --- |
| Run success rate | ≥ 97% |
| Monthly active users | 100+ |
| Repeat users (≥ 3 runs) | ≥ 35% |
| Rating | ≥ 4.6 with 10+ reviews |
| Monitoring (scheduled) users | ≥ 15%: this is your recurring revenue |

---

## 8. Roadmap, ranked by demand ÷ effort

1. **Microsoft Ads Library & TikTok Commercial Content Library** (EU and UK coverage): a differentiator for European agencies.
2. **Creative-level change alerts:** "competitor X launched 6 new video ads": thumbnails and copy in the alert.
3. **Standby (HTTP API) mode:** a sub-second cached lookup for single domains (`GET /?domain=acme.com`). This is the ideal shape for Clay and AI agents.
4. **Google Ads keyword and region breakdown** from the Transparency Center ad details.
5. **Bulk "lookalike" discovery:** given a category and city, find advertisers directly from the ad libraries, without an input list.

---

## 9. Risks (read this twice)

- **Platform changes and blocking.** Meta is the most hostile. Budget maintenance time every month, and keep the canary running.
- **Competition from Apify's own Facebook Ads Scraper and cheap per-ad scrapers.** Do not compete on per-ad price. Compete on *one verdict per business across platforms* plus signals and monitoring. If your README starts sounding like "scrapes ads", you have lost the positioning.
- **Spend estimates will be challenged.** Someone will compare a range with their real spend and find it off. That's survivable only because every estimate says "modelled", shows its assumptions and accepts custom CPMs. Never remove those labels to make the output look more impressive.
- **Accuracy disputes.** Name-only inputs are inherently ambiguous. The output says how it matched (`matchMethod`, `matchConfidence`). Keep that honesty; never present a `low` match as fact.
- **Terms of service.** The data is public and transparency-mandated, and nothing logs in. Still, you, not Apify, are responsible for how you operate the Actor; keep request rates moderate.
