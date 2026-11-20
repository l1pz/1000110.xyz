# Anna's Archive API (KOReader)

[bitesized/annas-archive-api](https://github.com/bitesized/annas-archive-api) scrapes Anna's Archive
search results into JSON and proxies authenticated fast downloads, so the
[KOReader plugin](https://github.com/bitesized/annasarchive.koplugin) can search and download books
straight onto the e-reader. This stack runs it on `https://annas.1000110.xyz`.

```
Kobo (KOReader + annas-archive plugin)
  │  https://annas.1000110.xyz/api/search, /api/download
  │  Authorization: Bearer <your Anna's Archive key>
  ▼
Traefik ──► annas-gate (forwardAuth): 200 only if sha256(key) == ANNAS_KEY_SHA256
  │
  ▼
annas-archive-api ──HTTPS──► annas-archive.gd (or the tld the plugin sends)
```

## Security model

- **TLS only**, on a subdomain of the site. The plugin itself knows nothing about TLS
  (upstream hardcodes `http://host:port/api`), so its `apiUrl` needs a three-line patch, below.
  Never point it at a plain HTTP port: the header carries the key that also logs in to Anna's Archive.
- **The plaintext key never reaches the server.** Requests carry it; the gate compares a SHA-256
  (`ANNAS_KEY_SHA256` in `.env`) and Traefik forwards the original request. The key lives only in
  the e-reader's settings (`settings/annasarchive.lua`), and in a password manager.
- **Only your key gets through.** Anyone else, with or without a valid Anna's Archive account, gets
  `401` before the request reaches the API, so this box is not a public scraping relay and does not
  burn its IP on other people's searches.
- **The web UI is behind `tinyauth`** like the other admin pages. The API path is not: the plugin
  cannot log in to Pocket ID.
- **Upstream is built, not vendored**: the image downloads a pinned commit tarball (that repo has no
  license file). Bump `UPSTREAM_SHA` in `compose.yaml` deliberately.
- The one sharp edge the gate cannot cover: the `tld` the plugin sends decides which mirror gets
  the key. Use a current mirror; retired domains get re-registered by strangers.

## Server setup (owner, once)

1. DNS: an `A` record for `annas` → the VPS IP, **DNS only** (grey cloud at Cloudflare). The
   certificate comes from the existing DNS-01 challenge; a proxied record adds a TLS layer and bot
   checks that the e-reader's HTTP client may not survive.
2. Create the `.env` (only the hash of the key, never the key):

   ```sh
   sudo mkdir -p /opt/stacks/annas-archive
   python3 -c 'import getpass, hashlib; print(hashlib.sha256(getpass.getpass("key: ").encode()).hexdigest())'
   sudo tee /opt/stacks/annas-archive/.env >/dev/null <<'EOF'
   ANNAS_KEY_SHA256=<paste the 64 hex characters>
   EOF
   sudo chmod 600 /opt/stacks/annas-archive/.env
   ```

   `getpass` reads without echoing, so the key stays out of the shell history. Strip spaces: the
   hash must match the exact string the plugin sends.

3. Allowlist the stack on the server:

   ```sh
   sudo bash deploy/install-stack-deploy.sh --allow annas-archive=/opt/stacks/annas-archive
   ```

4. Deploy: Actions → CI → Run workflow, branch `main`, `stack` = `annas-archive`. The log shows the
   `plan` first; the first run creates the two containers. Once that works, flip `"auto": true` in
   `stacks/manifest.json` in a small PR so later changes deploy by themselves.

5. Open `https://annas.1000110.xyz` in a browser: `tinyauth` asks you to log in, then the search UI
   loads (the key goes into its ⚙ Settings panel and stays in that browser's localStorage).

6. Smoke test from any machine (the gate, not an IP allowlist, is what keeps others out):

   ```sh
   read -rs ANNAS_KEY          # paste the key, Enter; nothing is echoed
   curl -sS -H "Authorization: Bearer $ANNAS_KEY" \
     'https://annas.1000110.xyz/api/search?query=clean%20code&limit=3&tld=gd'
   curl -s -o /dev/null -w '%{http_code}\n' \
     'https://annas.1000110.xyz/api/search?query=x'   # 401 without the key
   unset ANNAS_KEY
   ```

## KOReader setup

1. Install the plugin from its [latest release](https://github.com/bitesized/annasarchive.koplugin/releases/latest)
   and unpack it as `<koreader>/plugins/annasarchive.koplugin/` (the directory name must end in
   `.koplugin`; GitHub's "Download ZIP" gives `annasarchive.koplugin-main`, rename it).
2. Patch `main.lua` so it speaks HTTPS and drops the port when it is 443. Replace

   ```lua
   function AnnaPlugin:apiUrl()
       return string.format("http://%s:%s/api", self:apiHost(), self:apiPort())
   end
   ```

   with

   ```lua
   function AnnaPlugin:apiUrl()
       if self:apiPort() == "443" then
           return string.format("https://%s/api", self:apiHost())
       end
       return string.format("https://%s:%s/api", self:apiHost(), self:apiPort())
   end
   ```

   KOReader's bundled LuaSocket/LuaSec handle `https://` URLs (the same path OPDS and Wallabag use).
3. Restart KOReader, then **Anna's Archive → Settings**:

   | Setting | Value |
   | --- | --- |
   | API Host | `annas.1000110.xyz` |
   | API Port | `443` |
   | Anna's Archive TLD | a current mirror, e.g. `gd` |
   | Secret Key | your Anna's Archive account key |

4. Search, download a book, and check it lands in the download directory.

## Updating upstream

1. Read the commits at `github.com/bitesized/annas-archive-api` (security fixes, changed endpoints).
2. Set the new 40-character commit SHA in `compose.yaml` (`UPSTREAM_SHA`); merge. The image rebuilds on
   the next deploy.
3. Run one search and one download from the e-reader. If the scraper breaks, Anna's Archive's HTML
   changed: pin the previous SHA back, then report or wait upstream.

## Notes

- No Kuma monitor: the UI is behind `tinyauth`, and reaching the container over the Docker network
  would mean another shared network (and a deploy-order trap when Kuma starts before this stack).
  `restart: unless-stopped` and the CI `deploys` monitor cover the common failures; a broken upstream
  shows up as an error in the plugin.
- Logs: `docker logs annas-archive-api`, `docker logs annas-gate`. Deploy log:
  `/var/lib/stack-deploy/deploy.log`.
- Anna's Archive is a shadow library. This is a personal setup for material you have the right to
  read; the upstream README has the same caveat.