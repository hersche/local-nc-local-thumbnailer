import { createClient } from "webdav";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import axios from "axios";
import FormData from "form-data";
import "dotenv/config";

const { NC_URL, NC_USER, NC_PASS, TEMP_DIR, FOLDER_CACHE, THUMB_CACHE, FAIL_CACHE, SCAN_INTERVAL_DAYS } = process.env;

// Setup Paths
const urlObj = new URL(NC_URL);
const BASE_URL = `${urlObj.protocol}//${urlObj.host}`;
// Assume NC is at root or subdirectory. We need the index.php entry point.
// If NC_URL is https://example.com/remote.php/dav/files/user/
// The API is likely at https://example.com/index.php/apps/localthumbnailer/...
// We need to find the "root" of nextcloud from the NC_URL.
// Usually /remote.php/... means root is just before /remote.php
const NC_ROOT = NC_URL.split('/remote.php')[0];
const API_BASE = `${NC_ROOT}/index.php/apps/localthumbs/thumbnail`;
const DAV_PATH_PREFIX = urlObj.pathname;

console.log(`API Base: ${API_BASE}`);
console.log(`DAV Prefix: ${DAV_PATH_PREFIX}`);

const dav = createClient(NC_URL, { username: NC_USER, password: NC_PASS });
const VIDEO_EXTS = [".mp4", ".m4v", ".mov", ".avi", ".mkv", ".wmv"];
const COOLDOWN_MS = (parseInt(SCAN_INTERVAL_DAYS) || 7) * 24 * 60 * 60 * 1000;

// Axios for API
const client = axios.create({
    auth: { username: NC_USER, password: NC_PASS },
    headers: { 'OCS-APIRequest': 'true' }
});

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
    
    if (folderCache.has(relDir) && (now - folderCache.get(relDir) < COOLDOWN_MS)) return false;

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

            if (thumbCache.has(relPath)) continue;
            
            if (failCache.has(relPath)) {
                console.log(`[Skip] Previously failed: ${item.basename}`);
                continue;
            }
            
            if (await checkRemoteExists(relPath)) {
                 console.log(`[Skip] Already exists on server: ${item.basename}`);
                 markDone(relPath);
                 mediaInTree = true;
                 continue;
            }

            const fileHash = getHash(item.filename);
            const localVid = path.join(TEMP_DIR, `v_${fileHash}${ext}`);
            const localThumb = path.join(TEMP_DIR, `t_${fileHash}.jpg`);

            try {
                console.log(`[▶] Downloading: ${item.basename}`);
                const buffer = await dav.getFileContents(item.filename, { range: { start: 0, end: 15000000 } }); 
                fs.writeFileSync(localVid, buffer);

                await new Promise((resolve, reject) => {
                    ffmpeg(localVid)
                        .screenshots({
                            timestamps: ["00:00:02"],
                            filename: path.basename(localThumb),
                            folder: TEMP_DIR,
                            size: "1024x?"
                        })
                        .on("end", resolve)
                        .on("error", reject);
                });

                if (fs.existsSync(localThumb)) {
                     console.log(`[↑] Uploading thumb for: ${item.basename}`);
                     await uploadThumbnail(relPath, localThumb);
                     markDone(relPath);
                     console.log(`[✔] Success: ${item.basename}`);
                }
            } catch (err) {
                console.error(`[✘] Failed for ${item.basename}: ${err.message}`);
                markFailed(relPath);
            } finally {
                if (fs.existsSync(localVid)) fs.unlinkSync(localVid);
                if (fs.existsSync(localThumb)) fs.unlinkSync(localThumb);
            }
        }
    }

    if (!mediaInTree) updateFolderCache(relDir, now);
    return mediaInTree;
}

(async () => {
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    try { await processFolder("/"); console.log("Done."); } catch (err) { console.error("Fatal:", err); }
})();