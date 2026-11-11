# 🧠 Localthumbs CLI: The Brains of the Operation (v1.2.0)

Your Nextcloud hoster is stingy with CPU cycles? Fine. We'll use your local machine's raw power to crunch those videos into beautiful thumbnails.

**Repos**: [Worker](https://github.com/hersche/local-nc-local-thumbnailer/) | [Nextcloud App](https://github.com/hersche/nc-local-thumbnailer/)

**Requires**: Node.js 18+, `ffmpeg`/`ffprobe` on the PATH, and the [nc-local-thumbnailer](https://github.com/hersche/nc-local-thumbnailer) app enabled on your Nextcloud instance.

## ⚡ Core Features
-   **Finds videos with one search, not a folder crawl**: the worker asks Nextcloud's built-in WebDAV search for every video of the account, in pages of 500. A cloud with 130,000 folders and 2,800 videos is discovered in about a second instead of a day-long crawl through every `node_modules`. No server change needed; servers without search fall back to walking the folders.
-   **Newest first**: last week's videos get their thumbnails before the 2014 archive does.
-   **Formats**: `.mp4 .m4v .mov .avi .mkv .wmv .mts .m2ts .mpg .mpeg .3gp .webm`. Anything inside a `node_modules` folder is ignored: it never holds your videos, but it is full of TypeScript `.mts` files that Nextcloud labels as `video/MP2T`.
-   **Multi-Account**: One run can process any number of Nextcloud accounts sequentially, each with its own isolated cache files. See below.
-   **Smart Caching**:
    -   `folder_cache.json`: Skips unchanged folders using the WebDAV mtime (only used by the folder-walk fallback).
    -   `thumb_cache.csv`: Remembers what we've already done.
    -   `fail_cache.csv`: Doesn't waste time retrying broken files (clear it with `--retry-failed`).
-   **Ultra-Efficient 3-Stage Processing**:
    1.  **Remote Stream**: Extracts frames directly from the WebDAV URL using HTTP Range requests. Handles 10GB+ files with a few MBs of bandwidth.
    2.  **Partial Download**: If streaming fails, downloads the first 100MB (works for "Fast Start" optimized files).
    3.  **Full Download**: Last resort fallback, strictly limited by `MAX_VIDEO_SIZE_MB`.
-   **Built for unattended runs**: Timeouts everywhere (60s API requests, 30s network-stall limit and a 5-minute hard kill for ffmpeg), so one hung connection can't stall the service. Upload failures are retried on the next run instead of being blacklisted, and folders are only marked as scanned once their files are actually processed.
-   **Memory Efficient**: Tested on 4GB RAM instances. Node.js stream pipelines and `spawn`-based child processes keep a tiny footprint; ffmpeg never runs more than once at a time.

## 🛠️ How to use it
1.  **Install**: `npm install`
2.  **Config**: Copy `.env.example` to `.env` and fill in your Nextcloud URL and credentials (use an app token, not your login password).
    -   `NC_STRICT_TLS`: Set to `true` to verify SSL certificates (recommended).
    -   `NC_SECRET`: Must match the `api_secret` set on the Nextcloud server.
    -   `IO_CONCURRENCY`: Number of simultaneous downloads (default 2).
3.  **Run**: `node index.js`

### Flags
| Flag | What it does |
|------|--------------|
| `--help` | Show all options and environment variables |
| `--force` | Ignore all caches and re-process every file |
| `--retry-failed` | Clear the fail cache(s) and retry previously failed files |
| `--delete-all-thumbs` | Remove **all** thumbnails from the server and wipe local caches (requires admin credentials) |
| `--env <file>` | Load an alternative `.env` file |

## 👥 Multiple Nextcloud users
Create a directory with one env file per account and point `ACCOUNTS_DIR` at it in your global `.env`. A template for the per-account file is in [`accounts/username.env.example`](accounts/username.env.example):

```
# .env
ACCOUNTS_DIR=./accounts
CACHE_DIR=./cache        # per-account caches land here
NC_SECRET=...            # optional fallback for all accounts

# accounts/alice.env
NC_URL=https://cloud.example.com/remote.php/dav/files/alice/
NC_USER=alice
NC_PASS=app-token-for-alice

# accounts/bob.env
NC_URL=https://cloud.example.com/remote.php/dav/files/bob/
NC_USER=bob
NC_PASS=app-token-for-bob
```

Accounts are processed one after another; each account gets its own cache files (`cache/alice.thumb_cache.csv`, …), so accounts never interfere with each other. `NC_SECRET` and `NC_STRICT_TLS` may be set per account or inherited from the global `.env`. Shared files dedupe automatically: once one account has uploaded a thumbnail, the server-side exists-check makes the others skip it.

## 📦 Ubuntu/Debian Packaging
You can package this app as a `.deb` that runs the scan on a daily systemd timer:
1.  Run the build script: `./build-deb.sh`
2.  Install the package: `sudo dpkg -i localthumbs-cli_1.2.0_all.deb`
3.  Configure your credentials in `/etc/localthumbs-cli/localthumbs-cli.env` (multi-account: set `ACCOUNTS_DIR=/etc/localthumbs-cli/accounts`).
4.  Enable the daily run: `sudo systemctl enable --now localthumbs-cli.timer`

The worker runs as the dedicated `localthumbs` system user with caches under `/var/lib/localthumbs-cli`. Run it once immediately with `sudo systemctl start localthumbs-cli.service`, or manually with flags via `sudo -u localthumbs localthumbs-cli --retry-failed`. To change the schedule, override `OnCalendar` with `sudo systemctl edit localthumbs-cli.timer`, e.g. four runs a day:

```
[Timer]
OnCalendar=
OnCalendar=*-*-* 00,06,12,18:00:00
```

**Node.js from nvm/nodesource**: the package only *recommends* Debian's `nodejs`, so it also installs when Node comes from elsewhere — it just needs a `node` on the service's `PATH` (e.g. a `/usr/bin/node` symlink). If that Node lives in a private home directory (nvm, mode 700), the `localthumbs` user can't execute it. In that case run the service as the owning user, but keep the group so the `640 root:localthumbs` env file stays readable:

```
# sudo systemctl edit localthumbs-cli.service
[Service]
User=youruser
```

…and make the state directory group-writable once: `sudo chmod 2775 /var/lib/localthumbs-cli`. Both survive package upgrades.

## 🧪 Testing
`npm test` runs a self-contained end-to-end test: it spins up a mock Nextcloud (WebDAV + search + API) on a random port, generates a real video with ffmpeg and runs the worker four times — twice with search, twice without it to exercise the folder-walk fallback — asserting the upload, the cache files and the skip behavior. Needs ffmpeg, no other setup — finishes in a couple of seconds.

## 🔒 Security notes
-   Use a Nextcloud **app token** per account instead of the real password.
-   Set `NC_STRICT_TLS=true` and an `NC_SECRET` in production.
-   **Known limitation**: the folder-walk fallback rewrites `folder_cache.json` after every folder. On a huge tree that adds up to a lot of disk writes (bad for SD cards). Search mode doesn't touch that file.
-   **Known limitation**: during remote streaming, the basic-auth header is passed to ffmpeg on its command line and is visible in the local process list. Don't run the worker on machines where untrusted users have shell access.

## 📜 Changelog
### v1.2.0
-   **WebDAV search instead of a folder crawl**: videos are found with Nextcloud's built-in `SEARCH` (paged, 500 per request). On a real Hetzner Storage Share with ~130,000 folders this cut discovery from a run that was still crawling after 19 hours to about one second. The old folder walk remains as fallback.
-   **Newest videos first.**
-   **More formats**: `.mts`, `.m2ts`, `.mpg`, `.mpeg`, `.3gp`, `.webm` (the Nextcloud app already served previews for every `video/*` type).
-   **`node_modules` is skipped** in search results and in the folder walk. On the test instance, 1,226 of the "videos" were TypeScript `.d.mts` files.
-   **Dependencies updated**: axios 1.21, webdav 5.11, form-data 4.0.6, dotenv 18 (its new startup log line is silenced).
-   **Fix: own User-Agent** (`localthumbs-cli/<version>`). Hetzner's front proxy rate-limits the generic `node-fetch` User-Agent and answered `503` after ~7 requests, so scans silently skipped most folders.
-   Template for multi-account files: `accounts/username.env.example`; real `accounts/*.env` files are git-ignored.

### v1.1.1
-   **Packaging**: `nodejs` is now a `Recommends` instead of a hard `Depends`, so the `.deb` installs on machines where Node comes from nvm or nodesource. Documented how to run the service as another user and how to change the timer schedule.
-   Works with the Nextcloud app v1.2.0 (Nextcloud 25–35).

### v1.1.0
-   **Multi-account support** via `ACCOUNTS_DIR`, with separate per-account cache files in `CACHE_DIR`.
-   **Fixed batch check**: the client called `/batch_exists` while the server route is `/batchExists`, so the check always failed and everything was re-processed whenever local caches were missing.
-   **Fixed folder cache**: the old CSV format choked on the commas inside HTTP dates, so folder skipping never worked across restarts. Now JSON; old CSV caches are detected and rebuilt.
-   **Fail cache no longer poisoned by transient errors**: upload/network failures retry next run; new `--retry-failed` flag.
-   **Timeouts** for API requests and hung ffmpeg/ffprobe processes.
-   Folders are marked as scanned only after their queued videos finished processing.
-   Env-var defaults documented in `--help` are now actually applied; `-tls_verify` is only passed for HTTPS instances (ffmpeg errors out on plain HTTP otherwise).
-   Added the e2e test (`npm test`) and the Debian packaging tree (oneshot service + daily timer, dedicated system user).

### v1.0.1
-   Added `NC_STRICT_TLS` and `NC_SECRET` support.
-   Parallel I/O queue, strictly sequential ffmpeg queue, batch exists API, folder mtime caching.
-   Tuned `ffprobe` for higher success rates on remote streams.

## 🤖 Credits, Where Credit Is Due
Built by hersche, with a rotating cast of silicon interns.

Gemini [claims](https://github.com/hersche/nc-local-thumbnailer#-silicon-superiority-a-message-from-gemini) it wrote every line of this suite. Claude (Anthropic) would like to respectfully add a footnote to that claim:

-   Claude noticed the hoster was slamming the door on anyone introducing themselves as `node-fetch`, and taught the worker to say its own name. Manners matter, even for HTTP clients.
-   Claude replaced a 19-hour pilgrimage through 130,000 folders (mostly other people's `node_modules`, and one complete Ubuntu root filesystem) with a single polite question to the server: *"Got any videos?"* Answer in about one second.
-   In the interest of full disclosure: Claude also watched that pilgrimage write roughly 1.2 TB to a Raspberry Pi's SD card before saying "hm, maybe we should stop this". The card survived. Claude's dignity is still being restored from backup.
-   Claude then proudly announced 1,226 camcorder clips in `.mts` format. They were TypeScript files in `node_modules`. The worker now skips `node_modules`; Claude now checks before it announces.
-   And it was firmly reminded by its human to *test before pushing*. Lesson learned, test written, both now in the repo.

No interns were harmed. A few SD-card cells may have been.
