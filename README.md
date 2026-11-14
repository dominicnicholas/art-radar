# Boston Openings Map

A public map of gallery shows opening soon around Boston, built from the [Boston Art Radar calendar](https://artradar.org/calendar), plus a daily alert on your Mac and phone.

- `docs/` is the website (GitHub Pages serves this folder). `docs/data/openings.json` holds the openings.
- `update.mjs` reads artradar.org, rewrites `openings.json`, commits and pushes it if anything changed, then sends alerts:
  - **every day:** shows opening tomorrow (no alert when there are none)
  - **Sundays:** the week ahead
  - **if it breaks** (site down, layout changed): one "update failed" alert that day
- `install-mac.sh` schedules `update.mjs` to run daily on your Mac with launchd. If the Mac is asleep at that time, it runs when the Mac wakes.

It needs Node.js 18 or newer, and no npm packages.

## Setup

1. Copy this folder into your repo (or use it as the repo), then push:
   ```bash
   git add -A && git commit -m "Add Boston openings map" && git push
   ```
2. On GitHub, open the repo's **Settings → Pages**, set **Source: Deploy from a branch**, branch `main`, folder `/docs`. The site appears at https://dominicnicholas.github.io/art-radar/ after a minute.
3. Phone alerts: install the **ntfy** app (iOS/Android), tap **+**, and subscribe to a hard-to-guess topic name, e.g. `artradar-7f3k2q`. Anyone who knows the name can read the alerts, so keep it random.
4. Create `config.json` (copy `config.example.json`) and fill in `siteUrl` and `ntfyTopic`.
5. Test once by hand. This sends today's alerts even if they already went out:
   ```bash
   node update.mjs --force-notify --weekly
   ```
6. Schedule it (default 5:45pm daily; pass hour and minute to change):
   ```bash
   ./install-mac.sh
   ```

The push in step 1 and the daily push use your normal git login on the Mac, so `git push` must work in this folder without prompting.

## Everyday use

- Run now: `launchctl kickstart gui/$(id -u)/org.artradar.openings`
- Log: `logs/update.log`
- Stop: `launchctl bootout gui/$(id -u)/org.artradar.openings`
- Options: `--no-push`, `--no-notify`, `--force-notify`, `--weekly`

Map tiles © OpenStreetMap contributors. Listings belong to Boston Art Radar; the page links back to each show.
