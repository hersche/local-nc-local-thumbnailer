# 🧠 Localthumbs CLI: The Brains of the Operation (v1.1.0)

Your Nextcloud hoster is stingy with CPU cycles? Fine. We'll use your local machine's raw power to crunch those videos into beautiful thumbnails.

**Repos**: [Worker](https://github.com/hersche/local-nc-local-thumbnailer/) | [Nextcloud App](https://github.com/hersche/nc-local-thumbnailer/)

## ⚡ v1.1.0 Improvements
-   **Multi-Account**: Set `ACCOUNTS_DIR` to a directory with one `<name>.env` per Nextcloud account (each with its own `NC_URL`/`NC_USER`/`NC_PASS`). Accounts are processed sequentially — ffmpeg still never runs more than once at a time — with separate cache files per account in `CACHE_DIR` (default `./cache`).
-   **Fixed batch check**: The client called `/batch_exists` while the server route is `/batchExists`, so the batch check always failed and everything was re-processed whenever the local caches were missing. Fixed.
-   **Fixed folder cache**: The old CSV format choked on the commas inside HTTP dates, so folder skipping never worked across restarts. The folder cache is now JSON (`folder_cache.json`); old CSV caches are ignored and rebuilt.
-   **Fail cache no longer poisoned by transient errors**: Upload/network failures aren't fail-cached anymore (they're retried next run), and the new `--retry-failed` flag clears the fail cache without re-processing everything.
-   **Timeouts**: API requests (60s) and hung ffmpeg/ffprobe processes (hard kill after 5min, 30s network stall timeout) can no longer stall the service forever.
-   **Crash-safety**: A folder is only marked as scanned once all of its videos finished processing.
-   **Misc**: Env-var defaults documented in `--help` are now actually applied; `-tls_verify` is no longer passed for plain-HTTP instances (it made ffmpeg error out).

**Known limitation:** during remote streaming, the basic-auth header is passed to ffmpeg on its command line and is visible in the local process list. Don't run the worker on machines where other untrusted users have shell access.

## ⚡ v1.0.1 Improvements
-   **Security**: Added `NC_STRICT_TLS` and `NC_SECRET` support.
-   **Performance**: 
    -   **Parallel I/O**: `ioQueue` handles multiple downloads/API checks simultaneously.
    -   **Sequential Multimedia**: `ffmpegQueue` ensures `ffmpeg` and `ffprobe` never run concurrently.
    -   **Batch API**: Uses `batchExists` to minimize network overhead.
    -   **mtime Caching**: Folders are only re-scanned if their `lastmod` timestamp has changed.
-   **Stability**: Tuned `ffprobe` for higher success rates on remote streams.

## ⚡ Core Features
-   **Smart Caching**:
    -   `folder_cache.csv`: Skips unchanged folders using WebDAV mtime.
    -   `thumb_cache.csv`: Remembers what we've already done.
    -   `fail_cache.csv`: Doesn't waste time retrying broken files.
-   **Ultra-Efficient 3-Stage Processing**:
    1.  **Remote Stream**: Attempts to extract frames directly from the WebDAV URL using HTTP Range requests. This handles 10GB+ files using only a few MBs of bandwidth.
    2.  **Partial Download**: If streaming fails, downloads the first 100MB (works for "Fast Start" optimized files).
    3.  **Full Download**: Last resort fallback, strictly limited by `MAX_VIDEO_SIZE_MB`.
-   **Memory Efficient**: Tested on 4GB RAM instances. Uses Node.js stream pipelines and `spawn`-based child processes to keep a tiny footprint.

## 🛠️ How to use it
1.  **Install**: `npm install`
2.  **Config**: Copy `.env.example` to `.env` and fill in your Nextcloud URL and credentials.
    -   `NC_STRICT_TLS`: Set to `true` to verify SSL certificates (recommended).
    -   `NC_SECRET`: Must match the `api_secret` set on the Nextcloud server.
    -   `IO_CONCURRENCY`: Number of simultaneous downloads (default 2).
3.  **Run**: `node index.js`
4.  **Run (Help)**: `node index.js --help` (Show all available options and environment variables).
5.  **Run (Force Refresh)**: `node index.js --force` (Ignores all caches and overwrites existing thumbnails).
6.  **Run (Retry Failed)**: `node index.js --retry-failed` (Clears the fail cache(s) and retries previously failed files).
7.  **Run (Delete All)**: `node index.js --delete-all-thumbs` (Removes all thumbnails from the server and wipes local caches — requires admin credentials since v1.1.0).

## 👥 Multiple Nextcloud users
Create a directory with one env file per account and point `ACCOUNTS_DIR` at it in your global `.env`:

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

Accounts are processed one after another; each account gets its own cache files (`cache/alice.thumb_cache.csv`, …), so accounts never interfere with each other. `NC_SECRET` and `NC_STRICT_TLS` may be set per account or inherited from the global `.env`.

## 📦 Ubuntu/Debian Packaging
You can package this app as a `.deb` that runs the scan on a daily systemd timer:
1.  Run the build script: `./build-deb.sh`
2.  Install the package: `sudo dpkg -i localthumbs-cli_1.1.0_all.deb`
3.  Configure your credentials in `/etc/localthumbs-cli/localthumbs-cli.env` (multi-account: set `ACCOUNTS_DIR=/etc/localthumbs-cli/accounts`).
4.  Enable the daily run: `sudo systemctl enable --now localthumbs-cli.timer`

The worker runs as the dedicated `localthumbs` system user with caches under `/var/lib/localthumbs-cli`. Run it once immediately with `sudo systemctl start localthumbs-cli.service`, or manually with flags via `sudo -u localthumbs localthumbs-cli --retry-failed`. To change the schedule, override `OnCalendar` with `sudo systemctl edit localthumbs-cli.timer`.

**Note:** This worker requires the [nc-local-thumbnailer](https://github.com/hersche/nc-local-thumbnailer) app to be installed and enabled on your Nextcloud instance.