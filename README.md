# Coming Up in Boston Art

A public map and calendar of Boston art openings and events, with alerts to your phone and Mac.

- **Map:** https://dominicnicholas.github.io/art-radar/
- **Calendar feed:** https://dominicnicholas.github.io/art-radar/calendar.ics

## Sources

- **[Boston Art Radar](https://artradar.org/calendar):** exhibition openings, with venue locations.
- **Boston Art Review's [Weekly Happenings](https://www.bostonartreview.com/weekly-happenings):** everything in the newsletter, including talks, lectures, workshops, performances, receptions, open studios, fairs, closing shows, open calls for artists and new articles. It's read from Mailchimp's public archive of the newsletter ([feed](https://us17.campaign-archive.com/feed?u=ea83bc1f42383298569cb53c7&id=274aefc88d)), so no inbox access is needed. New issues go out on Tuesday afternoons.

Opening receptions in the newsletter are matched to Art Radar shows, so a show's reception date and time appear with it. Event addresses are placed on the map using Art Radar's venue list first, then OpenStreetMap's geocoder (Nominatim). Results are cached in `data/geocache.json`.

## Files

- `update.mjs` runs everything. It pulls the repo, reads both sources, writes `docs/data/*.json` and `docs/calendar.ics`, commits and pushes, then sends alerts.
- `bar.mjs` reads the Weekly Happenings issues. `ics.mjs` builds the calendar feed.
- `docs/` is the website (GitHub Pages serves this folder).
- `install-mac.sh` schedules `update.mjs` with launchd: **daily at 5:45pm**, and **Tuesdays at 8:15pm** to pick up the new issue the same evening. If the Mac is asleep, the run happens when it wakes.

## Alerts

- **Every evening:** what's tomorrow. That covers openings (with reception times), events, last days of shows, and open calls due in 3 days. Nothing is sent if tomorrow is empty.
- **Tuesday evening:** a summary of the new Weekly Happenings issue.
- **Sundays:** the week ahead.
- **If something breaks:** one alert that day saying which source failed. The other source still updates.

## Calendar

Subscribe once and it stays up to date:

- **Apple Calendar (Mac):** File → New Calendar Subscription → paste the calendar feed URL → set Auto-refresh to "Every hour".
- **iPhone:** Settings → Apps → Calendar → Calendar Accounts → Add Account → Other → Add Subscribed Calendar → paste the URL.
- **Google Calendar:** Other calendars → **+** → From URL → paste the URL. Google refreshes subscribed calendars only every 12–24 hours.

## Setup

Requires Node.js 18 or newer. No npm packages are needed.

1. Copy `config.example.json` to `config.json`, then set `ntfyTopic` to the topic you subscribed to in the ntfy phone app.
2. Test: `node update.mjs --force-notify --weekly --new-issue`
3. Schedule: `./install-mac.sh` (pass an hour and minute to change the daily time, e.g. `./install-mac.sh 18 30`).

`git push` must work in this folder without prompting.

## Everyday use

- Run now: `launchctl kickstart gui/$(id -u)/org.artradar.openings`
- Log: `logs/update.log`
- Stop: `launchctl bootout gui/$(id -u)/org.artradar.openings`
- Options: `--no-push`, `--no-notify`, `--force-notify`, `--weekly`, `--new-issue`

Map tiles © OpenStreetMap contributors. Listings belong to Boston Art Radar and Boston Art Review; every item links back to its source.
