# Launch guide (website + ads)

Everything below is prepared in code; the steps marked **you** need accounts or decisions only you can make.
Not legal or tax advice.

## 0. Decide first (you)

- **Data licence.** Ads make the site commercial. `dcaribou` is CC0, but the underlying Transfermarkt
  scrape has its own terms. Get a legal opinion, or switch to fully open sources, before monetising.
- **Business status.** Regular ad income usually means registering a trade (Germany: Gewerbeanmeldung,
  sole proprietor is enough; check small-business VAT rules). AdSense asks for your tax details.

## 1. Freeze your data

```
DCARIBOU_DIR=~/Downloads/archive FOOTBALL_PROVIDER=dcaribou npm run sync
npm run data:report -- --source dcaribou     # read it; fix gaps with data:player
npm run data:export -- --source dcaribou     # writes data/pitchside-dataset.json.gz
```

Commit the `.json.gz` (or upload it to the server) and run production with
`FOOTBALL_PROVIDER=file FOOTBALL_IMPORT_FILE=data/pitchside-dataset.json.gz`.

## 2. Deploy (you)

`Dockerfile`, `fly.toml` and `render.yaml` are ready. Example (Fly.io):

```
fly launch --no-deploy
fly postgres create && fly postgres attach <db>      # sets DATABASE_URL
fly secrets set PUBLIC_ORIGIN=https://yourdomain.com ADMIN_TOKEN=<long random> \
  FOOTBALL_PROVIDER=file FOOTBALL_IMPORT_FILE=data/pitchside-dataset.json.gz \
  LEGAL_NAME="Your Name" LEGAL_ADDRESS="Street 1\n12345 City" LEGAL_EMAIL=you@yourdomain.com
fly deploy
fly certs add yourdomain.com                          # then point your DNS as instructed
```

Check `https://yourdomain.com/api/health`, `/impressum`, `/privacy`, `/robots.txt`, `/sitemap.xml`.
Test the social preview with the Facebook Sharing Debugger / LinkedIn Post Inspector.

## 3. Legal pages (you)

`/impressum` and `/privacy` are German templates filled from `LEGAL_*`. Have them reviewed
(generator such as eRecht24, or a lawyer). No analytics are installed, so none are declared.

## 4. Ads (you apply, code is ready)

1. Create a Google AdSense account and add your site. It needs the live domain, Impressum, privacy page
   and real content. Approval takes days to weeks.
2. In AdSense create a responsive **display ad unit** → note its numeric slot id.
3. Apply for Google's game ads ("H5 Games Ads", `adBreak` API) in the same account if offered.
4. Set on the server (no rebuild needed):
   `ADS_CLIENT=ca-pub-XXXXXXXXXXXXXXXX` and `ADS_BANNER_SLOT=<slot id>` (+ `fly deploy` / restart).
5. That turns on, automatically: consent banner, `/ads.txt`, the relaxed CSP for Google domains,
   the banner on every page, and the **ad break before every third, fifth, … round on one phone**
   (= after every second round; the game clock stops while the ad runs) and **once at game end online**.
6. Never click your own ads. Use Google's test mode while developing.

Notes

- Whether an ad actually plays is Google's decision (frequency caps, inventory). The code asks at
  natural pauses only; if no ad is available, the game just continues.
- Google requires a certified consent platform for ads in the EEA/UK. The built-in banner gates the ad
  scripts; once AdSense is approved, switch on Google's own consent message (Privacy & messaging) for
  full compliance and remove ours if they conflict.
- Without `ADS_CLIENT` nothing ad-related loads and no banner appears.

## 5. After launch

Share links work from every result screen (Web Share on phones, copy otherwise). Watch retention
before spending on ads or an app-store version.
