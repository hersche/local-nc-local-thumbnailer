import { createClient } from "webdav";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import axios from "axios";
import FormData from "form-data";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { resolve } from "node:path";
import { pipeline } from "stream/promises";
import os from "os";
import http from "http";
import https from "https";
import { spawn } from "child_process";

const { values } = parseArgs({
    options: {
        env: {
            type: "string",
            default: ".env",
        },
    },
    strict: false,
});

// Check for flags
const FORCE_MODE = process.argv.includes("--force");
const DELETE_ALL_MODE = process.argv.includes("--delete-all-thumbs");
const RETRY_FAILED_MODE = process.argv.includes("--retry-failed");
const HELP_MODE = process.argv.includes("--help") || process.argv.includes("-h");

if (HELP_MODE) {
    console.log(`
🖼️  Localthumbs CLI - Usage Guide

Commands:
  node index.js                      Run a standard scan and upload missing thumbnails.
  node index.js --force              Ignore all caches and re-process all files.
  node index.js --retry-failed       Clear the fail cache(s) and retry previously failed files.
  node index.js --delete-all-thumbs  Remove all remote thumbnails and clear local caches (requires admin credentials).
  node index.js --env <file>         Load an alternative .env file.
  node index.js --help               Show this help message.

Environment Variables (set in .env):
  NC_URL             Nextcloud WebDAV URL (ending in /remote.php/dav/files/<user>/)
  NC_USER            Nextcloud Username
  NC_PASS            Nextcloud Password or App Token
  NC_SECRET          (Optional) API Secret matching the server configuration
  NC_STRICT_TLS      Set to "true" to enable strict SSL verification (default: false)

Multi-account:
  ACCOUNTS_DIR       Directory with one <name>.env per Nextcloud account.
                     Each file must set NC_URL, NC_USER and NC_PASS
                     (NC_SECRET / NC_STRICT_TLS fall back to the global .env).
                     Accounts are processed sequentially, each with its own
                     cache files in CACHE_DIR. When set, the single-account
                     NC_* values of the global .env are ignored.
  CACHE_DIR          Directory for per-account cache files (default: ./cache)

  IO_CONCURRENCY     Simultaneous downloads/checks (default: 2)
  FFMPEG_THREADS     Threads per FFmpeg process (default: Cores - 1)
  MAX_VIDEO_SIZE_MB  Maximum file size for full download fallback (default: 3000)
  SCAN_INTERVAL_DAYS Days to skip rescanning unchanged folders (default: 7)

Paths (single-account mode):
  TEMP_DIR           Directory for temporary processing (default: ./tmp_thumbs)
  FOLDER_CACHE       Path to folder mtime cache (default: ./folder_cache.json)
  THUMB_CACHE        Path to successful thumb cache (default: ./thumb_cache.csv)
  FAIL_CACHE         Path to failed file cache (default: ./fail_cache.csv)
    `);
    process.exit(0);
}

const envPath = resolve(process.cwd(), values.env);
const envResult = dotenv.config({ path: envPath });

if (envResult.error) {
    console.error(`[✘] Failed to load env file: ${envPath}`);
    console.error(envResult.error.message);
    process.exit(1);
}
console.log(`[✔] Loaded env: ${envPath}`);

// Global Error Handlers for Stability
process.on('uncaughtException', (err) => {
    console.error('CRITICAL: Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

if (FORCE_MODE) {
    console.log("!!! FORCE MODE ENABLED: Ignoring caches and re-processing all files !!!");
}

if (DELETE_ALL_MODE) {
    console.log("!!! DELETE ALL MODE ENABLED: Removing all remote thumbnails and clearing local caches !!!");
}

if (RETRY_FAILED_MODE) {
    console.log("!!! RETRY FAILED MODE ENABLED: Clearing fail cache(s) and retrying failed files !!!");
}

// --- GLOBAL SETTINGS (with the defaults documented in --help) ---

const TEMP_DIR = process.env.TEMP_DIR || "./tmp_thumbs";
const CACHE_DIR = process.env.CACHE_DIR || "./cache";
const ACCOUNTS_DIR = process.env.ACCOUNTS_DIR || "";
const COOLDOWN_MS = (parseInt(process.env.SCAN_INTERVAL_DAYS) || 7) * 24 * 60 * 60 * 1000;
const MAX_SIZE_BYTES = (parseInt(process.env.MAX_VIDEO_SIZE_MB) || 3000) * 1024 * 1024;
const IO_CONCURRENCY = parseInt(process.env.IO_CONCURRENCY) || 2;

const API_TIMEOUT_MS = 60 * 1000;             // HTTP API requests
const FFMPEG_KILL_TIMEOUT_MS = 5 * 60 * 1000; // Hard kill for hung ffmpeg/ffprobe processes
const RW_TIMEOUT_US = "30000000";             // 30s ffmpeg network stall timeout (microseconds)

const VIDEO_EXTS = [".mp4", ".m4v", ".mov", ".avi", ".mkv", ".wmv"];

// Identify ourselves instead of sending the HTTP libraries' default User-Agent:
// hosters' front proxies rate-limit generic ones like "node-fetch" (503 after a
// handful of WebDAV requests on Hetzner Storage Share).
const USER_AGENT = `localthumbs-cli/${JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf-8")).version}`;

console.log(`Max Video Size: ${(MAX_SIZE_BYTES / 1024 / 1024).toFixed(0)} MB`);

// --- HELPER: CPU THREADS ---
function getFfmpegThreads() {
    const cpus = os.cpus().length;
    let target = -1;
    if (process.env.FFMPEG_THREADS !== undefined && process.env.FFMPEG_THREADS !== "") {
        target = parseInt(process.env.FFMPEG_THREADS);
    }

    if (target === -1) {
        if (cpus <= 1) return 1;
        return cpus - 1;
    }

    return Math.max(1, target);
}

const THREAD_COUNT = getFfmpegThreads();
console.log(`FFmpeg configured to use ${THREAD_COUNT} threads.`);

// --- HELPER: QUEUE ---
class JobQueue {
    constructor(concurrency = 1) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }

    add(fn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            this.process();
        });
    }

    async process() {
        if (this.running >= this.concurrency || this.queue.length === 0) return;

        this.running++;
        const { fn, resolve, reject } = this.queue.shift();

        try {
            const result = await fn();
            resolve(result);
        } catch (e) {
            reject(e);
        } finally {
            this.running--;
            this.process();
        }
    }
}
// IO_CONCURRENCY for downloads/webdav, FFMPEG_CONCURRENCY strictly 1.
// Shared across accounts so ffmpeg never runs more than once at a time.
const ioQueue = new JobQueue(IO_CONCURRENCY);
const ffmpegQueue = new JobQueue(1);

const getHash = (str) => crypto.createHash("md5").update(str).digest("hex").substring(0, 8);

const getRelativePath = (acc, fullPath) => {
    let rel = fullPath;
    if (fullPath.startsWith(acc.DAV_PATH_PREFIX)) {
        rel = fullPath.substring(acc.DAV_PATH_PREFIX.length);
    }
    if (!rel.startsWith("/")) rel = "/" + rel;
    return rel;
}

// --- ACCOUNTS ---

function makeAccount(name, cfg) {
    const missing = ["NC_URL", "NC_USER", "NC_PASS"].filter(k => !cfg[k]);
    if (missing.length > 0) {
        console.error(`[✘] Account "${name}": missing ${missing.join(", ")}`);
        process.exit(1);
    }

    let ncUrl = cfg.NC_URL;
    if (!ncUrl.endsWith("/")) ncUrl += "/";
    if (!ncUrl.includes("/remote.php/dav/files/")) {
        console.error(`[✘] Account "${name}": NC_URL must be a WebDAV files URL (…/remote.php/dav/files/<user>/), got: ${ncUrl}`);
        process.exit(1);
    }

    const strictTls = cfg.NC_STRICT_TLS === "true";
    const agentOptions = {
        keepAlive: true,
        rejectUnauthorized: strictTls
    };
    const httpAgent = new http.Agent(agentOptions);
    const httpsAgent = new https.Agent(agentOptions);

    const urlObj = new URL(ncUrl);
    const NC_ROOT = ncUrl.split('/remote.php')[0];

    return {
        name,
        NC_URL: ncUrl,
        NC_USER: cfg.NC_USER,
        NC_PASS: cfg.NC_PASS,
        SECRET: cfg.NC_SECRET || "",
        STRICT_TLS: strictTls,
        IS_HTTPS: urlObj.protocol === "https:",
        NC_ROOT,
        API_BASE: `${NC_ROOT}/index.php/apps/localthumbs/thumbnail`,
        DAV_PATH_PREFIX: urlObj.pathname,
        dav: createClient(ncUrl, {
            username: cfg.NC_USER,
            password: cfg.NC_PASS,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            headers: { 'User-Agent': USER_AGENT },
            httpAgent: httpAgent,
            httpsAgent: httpsAgent
        }),
        client: axios.create({
            auth: { username: cfg.NC_USER, password: cfg.NC_PASS },
            headers: {
                'User-Agent': USER_AGENT,
                'OCS-APIRequest': 'true',
                'X-Localthumbs-Secret': cfg.NC_SECRET || ""
            },
            timeout: API_TIMEOUT_MS,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            httpAgent: httpAgent,
            httpsAgent: httpsAgent
        }),
    };
}

function loadAccounts() {
    if (ACCOUNTS_DIR) {
        const dir = resolve(process.cwd(), ACCOUNTS_DIR);
        let files;
        try {
            files = fs.readdirSync(dir).filter(f => f.endsWith(".env")).sort();
        } catch (e) {
            console.error(`[✘] Cannot read ACCOUNTS_DIR ${dir}: ${e.message}`);
            process.exit(1);
        }
        if (files.length === 0) {
            console.error(`[✘] No .env files found in ${dir}`);
            process.exit(1);
        }
        fs.mkdirSync(CACHE_DIR, { recursive: true });

        return files.map(f => {
            const name = path.basename(f, ".env");
            // Only the secret/TLS settings fall back to the global env — NC_URL
            // embeds the username, so inheriting it across accounts would be wrong.
            const cfg = {
                NC_SECRET: process.env.NC_SECRET,
                NC_STRICT_TLS: process.env.NC_STRICT_TLS,
                ...dotenv.parse(fs.readFileSync(path.join(dir, f), "utf-8")),
            };
            const acc = makeAccount(name, cfg);
            acc.files = {
                folderCache: path.join(CACHE_DIR, `${name}.folder_cache.json`),
                thumbCache: path.join(CACHE_DIR, `${name}.thumb_cache.csv`),
                failCache: path.join(CACHE_DIR, `${name}.fail_cache.csv`),
            };
            return acc;
        });
    }

    const acc = makeAccount("default", process.env);
    acc.files = {
        folderCache: process.env.FOLDER_CACHE || "./folder_cache.json",
        thumbCache: process.env.THUMB_CACHE || "./thumb_cache.csv",
        failCache: process.env.FAIL_CACHE || "./fail_cache.csv",
    };
    return [acc];
}

// --- CACHE LOADERS ---

function loadFolderCache(file) {
    const map = new Map(); // path -> { ts, mtime }
    if (fs.existsSync(file)) {
        try {
            const data = JSON.parse(fs.readFileSync(file, "utf-8"));
            for (const [k, v] of Object.entries(data)) map.set(k, v);
        } catch (e) {
            console.warn(`[!] Ignoring unreadable folder cache (legacy CSV format?): ${file}`);
        }
    }
    return map;
}

function loadLineCache(file) {
    const set = new Set();
    if (fs.existsSync(file)) {
        fs.readFileSync(file, "utf-8").split("\n").forEach(l => l.trim() && set.add(l.trim()));
    }
    return set;
}

// --- PER-ACCOUNT RUN ---

async function runAccount(acc) {
    console.log("\n" + "=".repeat(30));
    console.log(`👤 Account: ${acc.name} (${acc.NC_USER} @ ${acc.NC_ROOT})`);
    console.log(`API Base: ${acc.API_BASE}`);
    console.log(`DAV Prefix: ${acc.DAV_PATH_PREFIX}`);
    console.log(`Strict TLS: ${acc.STRICT_TLS}`);
    console.log("=".repeat(30));

    // Stats Tracking
    const stats = {
        uploaded: 0,
        failed: 0,
        skippedSize: 0,
        skippedSizeList: [], // Track paths of files too big
        skippedExists: 0,
        skippedCache: 0
    };

    if (RETRY_FAILED_MODE && fs.existsSync(acc.files.failCache)) {
        fs.unlinkSync(acc.files.failCache);
        console.log(`[✔] Cleared fail cache: ${acc.files.failCache}`);
    }

    const folderCache = loadFolderCache(acc.files.folderCache);
    const thumbCache = loadLineCache(acc.files.thumbCache);
    const failCache = loadLineCache(acc.files.failCache);

    // --- CACHE WRITERS ---

    function updateFolderCache(p, ts, mtime) {
        folderCache.set(p, { ts, mtime });
        fs.writeFileSync(acc.files.folderCache, JSON.stringify(Object.fromEntries(folderCache)));
    }

    function markDone(p) {
        thumbCache.add(p);
        fs.appendFileSync(acc.files.thumbCache, p + "\n");
    }

    function markFailed(p) {
        failCache.add(p);
        fs.appendFileSync(acc.files.failCache, p + "\n");
    }

    // --- CAPABILITIES ---
    let capabilities = { batch_exists: false };
    try {
        const res = await acc.client.get(`${acc.NC_ROOT}/ocs/v2.php/cloud/capabilities?format=json`);
        const data = res.data.ocs.data.capabilities.localthumbs;
        if (data) {
            capabilities = { ...capabilities, ...data.features };
            console.log(`[i] Remote capabilities detected:`, capabilities);
        }
    } catch (e) {
        console.warn(`[!] Failed to check capabilities: ${e.message}`);
    }

    // --- LOGIC ---

    async function checkRemoteExists(relPath) {
        try {
            const res = await acc.client.get(`${acc.API_BASE}/exists`, { params: { path: relPath } });
            return res.data.exists;
        } catch (e) {
            console.error(`Error checking remote existence: ${e.message}`);
            return false;
        }
    }

    async function checkBatchRemoteExists(relPaths) {
        if (!capabilities.batch_exists) {
            const results = {};
            for (const p of relPaths) {
                results[p] = await checkRemoteExists(p);
            }
            return results;
        }
        try {
            const res = await acc.client.post(`${acc.API_BASE}/batchExists`, { paths: relPaths });
            if (res.data.status === 'success') return res.data.results;
            throw new Error(res.data.message);
        } catch (e) {
            console.error(`Error in batch check: ${e.message}`);
            return {};
        }
    }

    async function uploadThumbnail(relPath, thumbPath) {
        const form = new FormData();
        form.append('path', relPath);
        form.append('thumbnail', fs.createReadStream(thumbPath));

        const res = await acc.client.post(`${acc.API_BASE}/upload`, form, {
            headers: { ...form.getHeaders() }
        });

        if (res.data.status !== 'success') throw new Error(res.data.message);
        return res.data;
    }

    async function processFolder(directory = "/") {
        const relDir = getRelativePath(acc, directory) || "/";
        const now = Date.now();

        // Check cache with mtime
        let dirStats;
        try {
            dirStats = await acc.dav.stat(relDir);
        } catch (e) {
            console.error(`!! WebDAV Stat Error: ${relDir} - ${e.message}`);
            return false;
        }

        if (!FORCE_MODE && folderCache.has(relDir)) {
            const cached = folderCache.get(relDir);
            if (cached.mtime === dirStats.lastmod && (now - cached.ts < COOLDOWN_MS)) {
                // console.log(`[Skip] Folder unchanged: ${relDir}`);
                return false;
            }
        }

        console.log(`Scanning: ${relDir}`);
        let items = [];
        try {
            items = await acc.dav.getDirectoryContents(relDir);
        } catch (e) {
            console.error(`!! WebDAV Access Error: ${relDir} - ${e.message}`);
            return false;
        }

        let mediaInTree = false;
        const videosToProcess = [];

        for (const item of items) {
            if (item.type === "directory") {
                if (await processFolder(item.filename)) mediaInTree = true;
                continue;
            }

            const ext = path.extname(item.filename).toLowerCase();
            if (VIDEO_EXTS.includes(ext)) {
                mediaInTree = true;
                const relPath = getRelativePath(acc, item.filename);

                if (!FORCE_MODE) {
                    if (thumbCache.has(relPath)) {
                        stats.skippedCache++;
                        continue;
                    }
                    if (failCache.has(relPath)) {
                        // console.log(`[Skip] Previously failed: ${relPath}`);
                        stats.skippedCache++;
                        continue;
                    }
                }
                videosToProcess.push(item);
            }
        }

        const jobPromises = [];

        // Batch existence check
        if (videosToProcess.length > 0) {
            const pathsToCheck = videosToProcess.map(v => getRelativePath(acc, v.filename));
            const remoteResults = await checkBatchRemoteExists(pathsToCheck);

            for (const item of videosToProcess) {
                const relPath = getRelativePath(acc, item.filename);
                if (!FORCE_MODE && remoteResults[relPath]) {
                    console.log(`[Skip] Already exists on server: ${relPath}`);
                    markDone(relPath);
                    stats.skippedExists++;
                    continue;
                }

                // Add to IO Queue
                jobPromises.push(ioQueue.add(async () => {
                    const ext = path.extname(item.filename).toLowerCase();
                    const fileHash = getHash(item.filename);
                    const localVid = path.join(TEMP_DIR, `v_${acc.name}_${fileHash}${ext}`);
                    const localThumb = path.join(TEMP_DIR, `t_${acc.name}_${fileHash}.jpg`);

                    // 3-Stage Process
                    const processVideo = async () => {
                        // Stage 1: Remote Stream (Efficient)
                        try {
                            console.log(`[▶] Attempt 1: Remote Stream (Efficient) for ${relPath}`);

                            const pathEncoded = relPath.split('/').map(encodeURIComponent).join('/');
                            const fileUrl = new URL(pathEncoded.substring(1), acc.NC_URL).href;
                            const authHeader = "Basic " + Buffer.from(`${acc.NC_USER}:${acc.NC_PASS}`).toString("base64");

                            // Probe using spawn - Tuned for remote streams
                            const args = [
                                '-v', 'quiet',
                                '-print_format', 'json',
                                '-show_format',
                                '-analyzeduration', '20M',
                                '-probesize', '20M',
                                '-rw_timeout', RW_TIMEOUT_US,
                                // ffmpeg rejects -tls_verify on plain http URLs
                                ...(acc.IS_HTTPS ? ['-tls_verify', acc.STRICT_TLS ? '1' : '0'] : []),
                                '-headers', `Authorization: ${authHeader}\r\n`,
                                fileUrl
                            ];

                            const stdout = await ffmpegQueue.add(() => new Promise((resolve, reject) => {
                                const proc = spawn('ffprobe', args);
                                let out = '', err = '';
                                const killTimer = setTimeout(() => proc.kill('SIGKILL'), FFMPEG_KILL_TIMEOUT_MS);
                                proc.stdout.on('data', d => out += d);
                                proc.stderr.on('data', d => err += d);
                                proc.on('close', code => {
                                    clearTimeout(killTimer);
                                    if (code === 0) resolve(out);
                                    else reject(new Error(`Exit code ${code}.`));
                                });
                                proc.on('error', e => {
                                    clearTimeout(killTimer);
                                    reject(e);
                                });
                            }));

                            const metadata = JSON.parse(stdout);
                            if (!metadata.format) throw new Error("No format detected");
                            const duration = parseFloat(metadata.format.duration || 0);

                            // FFmpeg execution must be sequential
                            await ffmpegQueue.add(() => generateThumbnail(fileUrl, duration, localThumb, true, authHeader));
                            return; // Success!
                        } catch (err) {
                            console.log(`[!] Remote stream failed (${err.message}). Falling back...`);
                        }

                        // Stage 2: Partial Download (100MB)
                        try {
                            console.log(`[▶] Attempt 2: Partial Download (100MB) for ${relPath}`);
                            const MAX_BYTES = 100 * 1024 * 1024;
                            await attemptDownload(item.filename, localVid, { range: { start: 0, end: MAX_BYTES } });

                            const duration = await ffmpegQueue.add(() => getLocalDuration(localVid));
                            await ffmpegQueue.add(() => generateThumbnail(localVid, duration, localThumb, false));
                            return; // Success!
                        } catch (err) {
                            console.log(`[!] Partial processing failed (${err.message}). Falling back...`);
                        }

                        // Stage 3: Full Download (Last Resort)
                        if (item.size > MAX_SIZE_BYTES) {
                            console.log(`[Skip] Too large for fallback (${(item.size / 1024 / 1024).toFixed(2)} MB): ${relPath}`);
                            stats.skippedSize++;
                            stats.skippedSizeList.push(`${relPath} (${(item.size / 1024 / 1024).toFixed(2)} MB)`);
                            return;
                        }

                        console.log(`[▶] Attempt 3: Full Download for ${relPath}`);
                        await attemptDownload(item.filename, localVid, {});
                        const duration = await ffmpegQueue.add(() => getLocalDuration(localVid));
                        await ffmpegQueue.add(() => generateThumbnail(localVid, duration, localThumb, false));
                    };

                    // --- Helpers for Process ---

                    const attemptDownload = async (src, dest, options, retries = 5) => {
                        for (let i = 0; i < retries; i++) {
                            try {
                                const downloadStream = acc.dav.createReadStream(src, options);
                                await pipeline(downloadStream, fs.createWriteStream(dest));
                                return;
                            } catch (e) {
                                if (i === retries - 1) throw e;
                                await new Promise(r => setTimeout(r, (i + 1) * 5000));
                            }
                        }
                    };

                    const getLocalDuration = (filePath) => {
                        return new Promise((resolve, reject) => {
                            ffmpeg.ffprobe(filePath, (err, metadata) => {
                                if (err) return reject(new Error(`Probe failed: ${err.message}`));
                                resolve(metadata.format.duration || 0);
                            });
                        });
                    };

                    const generateThumbnail = (input, duration, output, isRemote, authHeader = null) => {
                        return new Promise((resolve, reject) => {
                            let time = 0;
                            if (duration > 50) time = 50;
                            else if (duration > 40) time = 40;
                            else if (duration > 30) time = 30;
                            else if (duration > 20) time = 20;
                            else if (duration > 10) time = 10;
                            else if (duration > 5) time = 5;
                            else time = Math.max(0, duration * 0.2);

                            const cmd = ffmpeg(input);

                            if (isRemote && authHeader) {
                                cmd.inputOptions([
                                    '-headers', `Authorization: ${authHeader}\r\n`,
                                    ...(acc.IS_HTTPS ? ['-tls_verify', acc.STRICT_TLS ? '1' : '0'] : []),
                                    '-rw_timeout', RW_TIMEOUT_US,
                                    `-threads ${THREAD_COUNT}`
                                ]);
                            } else {
                                cmd.inputOptions([`-threads ${THREAD_COUNT}`]);
                            }

                            let killTimer = null;
                            const settle = (fn) => (arg) => {
                                if (killTimer) clearTimeout(killTimer);
                                fn(arg);
                            };
                            cmd.on('start', () => {
                                killTimer = setTimeout(() => cmd.kill('SIGKILL'), FFMPEG_KILL_TIMEOUT_MS);
                            });

                            cmd.outputOptions([`-threads ${THREAD_COUNT}`])
                               .screenshots({
                                    timestamps: [time],
                                    filename: path.basename(output),
                                    folder: path.dirname(output),
                                    size: "1024x?"
                                })
                                .on("end", settle(resolve))
                                .on("error", settle(reject));
                        });
                    };

                    // --- Execution ---

                    try {
                        try {
                            await processVideo();
                        } catch (err) {
                            console.error(`[✘] Failed for ${relPath}: ${err.message}`);
                            markFailed(relPath);
                            stats.failed++;
                            return;
                        }

                        if (fs.existsSync(localThumb)) {
                            try {
                                console.log(`[↑] Uploading thumb: ${relPath}`);
                                await uploadThumbnail(relPath, localThumb);
                                markDone(relPath);
                                stats.uploaded++;
                            } catch (err) {
                                // Upload errors are transient (server/network) — don't fail-cache the file
                                console.error(`[✘] Upload failed for ${relPath} (will retry next run): ${err.message}`);
                                stats.failed++;
                            }
                        }
                    } finally {
                        if (fs.existsSync(localVid)) fs.unlinkSync(localVid);
                        if (fs.existsSync(localThumb)) fs.unlinkSync(localThumb);
                    }
                }));
            }
        }

        // Only mark the folder as scanned once all of its queued jobs have settled,
        // so a crash mid-run doesn't hide unprocessed files behind the folder cache.
        if (jobPromises.length > 0) {
            Promise.allSettled(jobPromises).then(() => updateFolderCache(relDir, now, dirStats.lastmod));
        } else {
            updateFolderCache(relDir, now, dirStats.lastmod);
        }
        return mediaInTree;
    }

    await processFolder("/");
    // Wait for all queued jobs to finish
    while (ioQueue.running > 0 || ioQueue.queue.length > 0 || ffmpegQueue.running > 0 || ffmpegQueue.queue.length > 0) {
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log("\n" + "=".repeat(30));
    console.log(`🏁 Scan Complete for "${acc.name}"`);
    console.log("=".repeat(30));
    console.log(`✅ Uploaded: ${stats.uploaded}`);
    console.log(`❌ Failed:   ${stats.failed}`);
    console.log(`⏩ Skipped (Size):   ${stats.skippedSize}`);
    if (stats.skippedSizeList.length > 0) {
        stats.skippedSizeList.forEach(item => console.log(`   - ${item}`));
    }
    console.log(`⏩ Skipped (Exists): ${stats.skippedExists}`);
    console.log(`⏩ Skipped (Cache):  ${stats.skippedCache}`);
    console.log("=".repeat(30));
}

(async () => {
    const accounts = loadAccounts();
    console.log(`[i] Accounts: ${accounts.map(a => a.name).join(", ")}`);

    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

    if (DELETE_ALL_MODE) {
        const doneRoots = new Set();
        for (const acc of accounts) {
            // deleteAll wipes the whole instance's thumbs — call it once per server
            if (!doneRoots.has(acc.NC_ROOT)) {
                doneRoots.add(acc.NC_ROOT);
                try {
                    console.log(`[▶] Requesting server-side thumbnail deletion (${acc.NC_ROOT}, as ${acc.NC_USER})...`);
                    const res = await acc.client.post(`${acc.API_BASE}/deleteAll`);
                    if (res.data.status !== 'success') throw new Error(res.data.message);
                    console.log(`[✔] Server response: ${res.data.message}`);
                } catch (e) {
                    console.error(`[✘] Delete failed: ${e.message} (note: requires admin credentials)`);
                    process.exit(1);
                }
            }

            for (const f of Object.values(acc.files)) {
                if (fs.existsSync(f)) fs.unlinkSync(f);
            }
            console.log(`[✔] Local caches cleared for account "${acc.name}".`);
        }
        process.exit(0);
    }

    for (const acc of accounts) {
        try {
            await runAccount(acc);
        } catch (err) {
            console.error(`[✘] Account "${acc.name}" failed:`, err);
        }
    }
})();
