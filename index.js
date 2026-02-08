import { createClient } from "webdav";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import axios from "axios";
import FormData from "form-data";
import "dotenv/config";
import { pipeline } from "stream/promises";
import os from "os";
import http from "http";
import https from "https";
import { Transform } from "stream";
import { exec, spawn } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Global Error Handlers for Stability
process.on('uncaughtException', (err) => {
    console.error('CRITICAL: Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

const { NC_URL, NC_USER, NC_PASS, TEMP_DIR, FOLDER_CACHE, THUMB_CACHE, FAIL_CACHE, SCAN_INTERVAL_DAYS, FFMPEG_THREADS, MAX_VIDEO_SIZE_MB } = process.env;

// Stats Tracking
const stats = {
    uploaded: 0,
    failed: 0,
    skippedSize: 0,
    skippedSizeList: [], // Track paths of files too big
    skippedExists: 0,
    skippedCache: 0
};

// Check for force flag
const FORCE_MODE = process.argv.includes("--force");
if (FORCE_MODE) {
    console.log("!!! FORCE MODE ENABLED: Ignoring caches and re-processing all files !!!");
}

// Setup Paths
const urlObj = new URL(NC_URL);
const BASE_URL = `${urlObj.protocol}//${urlObj.host}`;
const NC_ROOT = NC_URL.split('/remote.php')[0];
const API_BASE = `${NC_ROOT}/index.php/apps/localthumbs/thumbnail`;
const DAV_PATH_PREFIX = urlObj.pathname;
const MAX_SIZE_BYTES = (parseInt(MAX_VIDEO_SIZE_MB) || 3000) * 1024 * 1024;

console.log(`API Base: ${API_BASE}`);
console.log(`DAV Prefix: ${DAV_PATH_PREFIX}`);
console.log(`Max Video Size: ${(MAX_SIZE_BYTES / 1024 / 1024).toFixed(0)} MB`);

// Connection Agents with Keep-Alive
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const dav = createClient(NC_URL, {
    username: NC_USER, 
    password: NC_PASS,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    httpAgent: httpAgent,
    httpsAgent: httpsAgent
});

const VIDEO_EXTS = [".mp4", ".m4v", ".mov", ".avi", ".mkv", ".wmv"];
const COOLDOWN_MS = (parseInt(SCAN_INTERVAL_DAYS) || 7) * 24 * 60 * 60 * 1000;

// Axios for API
const client = axios.create({
    auth: { username: NC_USER, password: NC_PASS },
    headers: { 'OCS-APIRequest': 'true' },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    httpAgent: httpAgent,
    httpsAgent: httpsAgent
});

// --- HELPER: CPU THREADS ---
function getFfmpegThreads() {
    const cpus = os.cpus().length;
    let target = -1;
    if (FFMPEG_THREADS !== undefined && FFMPEG_THREADS !== "") {
        target = parseInt(FFMPEG_THREADS);
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
const jobQueue = new JobQueue(1);

const getHash = (str) => crypto.createHash("md5").update(str).digest("hex").substring(0, 8);
const getRelativePath = (fullPath) => {
    let rel = fullPath;
    if (fullPath.startsWith(DAV_PATH_PREFIX)) {
        rel = fullPath.substring(DAV_PATH_PREFIX.length);
    }
    if (!rel.startsWith("/")) rel = "/" + rel;
    return rel;
}

// --- CACHE LOADERS ---

const folderCache = new Map();
if (fs.existsSync(FOLDER_CACHE)) {
    fs.readFileSync(FOLDER_CACHE, "utf-8").split("\n").forEach(l => {
        if (l.includes(',')) { const [p, ts] = l.split(","); folderCache.set(p, parseInt(ts)); }
    });
}

const thumbCache = new Set();
if (fs.existsSync(THUMB_CACHE)) {
    fs.readFileSync(THUMB_CACHE, "utf-8").split("\n").forEach(l => l.trim() && thumbCache.add(l.trim()));
}

const failCache = new Set();
if (fs.existsSync(FAIL_CACHE)) {
    fs.readFileSync(FAIL_CACHE, "utf-8").split("\n").forEach(l => l.trim() && failCache.add(l.trim()));
}

// --- CACHE WRITERS ---

function updateFolderCache(p, ts) {
    folderCache.set(p, ts);
    fs.writeFileSync(FOLDER_CACHE, Array.from(folderCache.entries()).map(([k, v]) => `${k},${v}`).join("\n"));
}

function markDone(p) {
    thumbCache.add(p);
    fs.appendFileSync(THUMB_CACHE, p + "\n");
}

function markFailed(p) {
    failCache.add(p);
    fs.appendFileSync(FAIL_CACHE, p + "\n");
}

// --- LOGIC ---

async function checkRemoteExists(relPath) {
    try {
        const res = await client.get(`${API_BASE}/exists`, { params: { path: relPath } });
        return res.data.exists;
    } catch (e) {
        console.error(`Error checking remote existence: ${e.message}`);
        return false;
    }
}

async function uploadThumbnail(relPath, thumbPath) {
    const form = new FormData();
    form.append('path', relPath);
    form.append('thumbnail', fs.createReadStream(thumbPath));

    const res = await client.post(`${API_BASE}/upload`, form, {
        headers: { ...form.getHeaders() }
    });
    
    if (res.data.status !== 'success') throw new Error(res.data.message);
    return res.data;
}

async function processFolder(directory = "/") {
    const relDir = getRelativePath(directory) || "/";
    const now = Date.now();
    
    if (!FORCE_MODE && folderCache.has(relDir) && (now - folderCache.get(relDir) < COOLDOWN_MS)) return false;

    console.log(`Scanning: ${relDir}`);
    let items = [];
    try {
        items = await dav.getDirectoryContents(relDir);
    } catch (e) {
        console.error(`!! WebDAV Access Error: ${relDir} - ${e.message}`);
        return false;
    }

    let mediaInTree = false;

    for (const item of items) {
        if (item.type === "directory") {
            if (await processFolder(item.filename)) mediaInTree = true;
            continue;
        }

        const ext = path.extname(item.filename).toLowerCase();
        if (VIDEO_EXTS.includes(ext)) {
            mediaInTree = true;
            const relPath = getRelativePath(item.filename);

            if (!FORCE_MODE) {
                if (thumbCache.has(relPath)) {
                    stats.skippedCache++;
                    continue;
                }
                if (failCache.has(relPath)) {
                    console.log(`[Skip] Previously failed: ${relPath}`);
                    stats.skippedCache++;
                    continue;
                }
            }
            
            await jobQueue.add(async () => {
                if (!FORCE_MODE) {
                    if (await checkRemoteExists(relPath)) {
                         console.log(`[Skip] Already exists on server: ${relPath}`);
                         markDone(relPath);
                         stats.skippedExists++;
                         return;
                    }
                }

                const fileHash = getHash(item.filename);
                const localVid = path.join(TEMP_DIR, `v_${fileHash}${ext}`);
                const localThumb = path.join(TEMP_DIR, `t_${fileHash}.jpg`);

                // 3-Stage Process
                const processVideo = async () => {
                    // Stage 1: Remote Stream (Efficient)
                    try {
                        console.log(`[▶] Attempt 1: Remote Stream (Efficient) for ${relPath}`);
                        
                                                // Properly encode the path for the URL
                        
                                                const pathEncoded = item.filename.split('/').map(encodeURIComponent).join('/');
                        
                                                
                        
                                                // Use NC_URL as base to ensure remote.php/... prefix is included correctly
                        
                                                const fileUrl = new URL(pathEncoded.startsWith('/') ? pathEncoded.substring(1) : pathEncoded, NC_URL).href;
                        
                                                
                        
                                                const authHeader = "Basic " + Buffer.from(`${NC_USER}:${NC_PASS}`).toString("base64");
                        
                        // Probe using spawn (no shell, safer for special chars in auth header/url)
                        const args = [
                            '-v', 'quiet',
                            '-print_format', 'json',
                            '-show_format',
                            '-tls_verify', '0',
                            '-headers', `Authorization: ${authHeader}\r\n`,
                            fileUrl
                        ];

                        // Debug: Print probe command (masking auth)
                        // console.log(`[Debug] Probing: ffprobe ${args.map(a => a.includes('Authorization') ? 'Authorization: ***' : a).join(' ')}`);

                        const stdout = await new Promise((resolve, reject) => {
                            const proc = spawn('ffprobe', args);
                            let out = '', err = '';
                            proc.stdout.on('data', d => out += d);
                            proc.stderr.on('data', d => err += d);
                            proc.on('close', code => {
                                if (code === 0) resolve(out);
                                else reject(new Error(`Exit code ${code}. Stderr: ${err} Stdout: ${out}`));
                            });
                            proc.on('error', reject);
                        });
                        
                        const metadata = JSON.parse(stdout);
                        if (!metadata.format) throw new Error("No format detected in ffprobe output");
                        const duration = parseFloat(metadata.format.duration || 0);

                        await generateThumbnail(fileUrl, duration, localThumb, true, authHeader);
                        return; // Success!
                    } catch (err) {
                        // Clean up error message to be concise
                        const msg = err.message.replace(/\n/g, ' ').substring(0, 200);
                        console.log(`[!] Remote stream failed (${msg}). Falling back to partial download...`);
                    }

                    // Stage 2: Partial Download (100MB)
                    try {
                        console.log(`[▶] Attempt 2: Partial Download (100MB) for ${relPath}`);
                        const MAX_BYTES = 100 * 1024 * 1024;
                        await attemptDownload(item.filename, localVid, { range: { start: 0, end: MAX_BYTES } });
                        
                        const duration = await getLocalDuration(localVid); // Will fail if moov is missing
                        await generateThumbnail(localVid, duration, localThumb, false);
                        return; // Success!
                    } catch (err) {
                        console.log(`[!] Partial processing failed (${err.message}). Checking size for full download...`);
                    }

                    // Stage 3: Full Download (Last Resort)
                    if (item.size > MAX_SIZE_BYTES) {
                        console.log(`[Skip] Full file too large for fallback (${(item.size / 1024 / 1024).toFixed(2)} MB): ${relPath}`);
                        stats.skippedSize++;
                        stats.skippedSizeList.push(`${relPath} (${(item.size / 1024 / 1024).toFixed(2)} MB)`);
                        return;
                    }

                    console.log(`[▶] Attempt 3: Full Download for ${relPath}`);
                    await attemptDownload(item.filename, localVid, {});
                    const duration = await getLocalDuration(localVid);
                    await generateThumbnail(localVid, duration, localThumb, false);
                };

                // --- Helpers for Process ---

                const attemptDownload = async (src, dest, options, retries = 5) => {
                    for (let i = 0; i < retries; i++) {
                        try {
                            if (i > 0) console.log(`[⬇] Attempt ${i+1}/${retries} starting for ${relPath}...`);
                            const downloadStream = dav.createReadStream(src, options);
                            let downloadedBytes = 0;
                            let lastLogged = 0;
                            const progressMonitor = new Transform({
                                transform(chunk, encoding, callback) {
                                    downloadedBytes += chunk.length;
                                    if ((downloadedBytes - lastLogged) > (50 * 1024 * 1024)) {
                                        const mb = (downloadedBytes / 1024 / 1024).toFixed(2);
                                        process.stdout.write(`\r[⬇] Downloading... ${mb} MB`);
                                        lastLogged = downloadedBytes;
                                    }
                                    callback(null, chunk);
                                }
                            });
                            await pipeline(downloadStream, progressMonitor, fs.createWriteStream(dest));
                            process.stdout.write("\n");
                            return;
                        } catch (e) {
                            process.stdout.write("\n");
                            if (i === retries - 1) throw e;
                            const delay = (i + 1) * 5000;
                            await new Promise(r => setTimeout(r, delay));
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

                        console.log(`[i] Video duration: ${duration}s, taking thumb at ${time}s`);

                        const cmd = ffmpeg(input);
                        
                        if (isRemote && authHeader) {
                            cmd.inputOptions([
                                '-headers', `Authorization: ${authHeader}\r\n`,
                                '-tls_verify', '0',
                                `-threads ${THREAD_COUNT}`
                            ]);
                        } else {
                            cmd.inputOptions([`-threads ${THREAD_COUNT}`]);
                        }

                        cmd.outputOptions([`-threads ${THREAD_COUNT}`])
                           .screenshots({
                                timestamps: [time],
                                filename: path.basename(output),
                                folder: path.dirname(output),
                                size: "1024x?"
                            })
                            .on("end", resolve)
                            .on("error", reject);
                    });
                };

                // --- Execution ---

                try {
                    await processVideo();

                    if (fs.existsSync(localThumb)) {
                            console.log(`[↑] Uploading thumb for: ${relPath}`);
                            await uploadThumbnail(relPath, localThumb);
                            markDone(relPath);
                            stats.uploaded++;
                            console.log(`[✔] Success: ${relPath}`);
                    }
                } catch (err) {
                    console.error(`[✘] Failed for ${relPath}: ${err.message}`);
                    markFailed(relPath);
                    stats.failed++;
                } finally {
                    if (fs.existsSync(localVid)) fs.unlinkSync(localVid);
                    if (fs.existsSync(localThumb)) fs.unlinkSync(localThumb);
                }
            });
        }
    }

    if (!mediaInTree) updateFolderCache(relDir, now);
    return mediaInTree;
}

(async () => {
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    try { 
        await processFolder("/"); 
        console.log("\n" + "=".repeat(30));
        console.log("🏁 Scan Complete");
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
    } catch (err) { 
        console.error("Fatal:", err); 
    }
})();