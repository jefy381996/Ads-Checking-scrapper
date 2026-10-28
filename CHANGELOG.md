# Changelog

## 1.0 (unreleased)

- Meta Ad Library check (Facebook, Instagram, Messenger, Audience Network) with page discovery from the website, landing-page-domain attribution and a 30-day page-ID cache.
- Google Ads Transparency Center check by domain or advertiser name.
- LinkedIn Ad Library check with advertiser verification.
- Website scan for 17 ad pixels, analytics, marketing tools, e-commerce platform and social profiles, including pixels inside Google Tag Manager and gtag containers.
- Verdict, confidence, 0-100 advertiser score, opportunity signals and outreach snippet.
- Change monitoring between runs with "only output changes" alert mode.
- Import from any Apify dataset (Google Maps Scraper and others).
- Pay-per-event billing that never charges for failed checks and respects the run's maximum charge.
- Ad strength: a 0-100 winning-ad score per live Meta ad (age, copies, placements, EU reach) with reasons, plus account activity (active testing / steady / static) that discounts ad age in unmanaged accounts.
- EU transparency: Meta EU reach, country/age/gender split and payer via the official Ad Library API (optional token), and LinkedIn impression ranges, run dates and payer from ad detail pages.
- Modelled EU spend ranges (lifetime and monthly, per platform and combined) with printed assumptions, custom CPM overrides and two-significant-figure rounding.
- New signals: `SET_AND_FORGET`, `WINNING_CREATIVES`, `AGENCY_MANAGED`, `BIG_EU_SPENDER`. Monitoring now counts switched-off ads.
- New `eu-insights` pay-per-event event, charged only when EU data is returned.
