// End-to-end test: runs the worker against a mock Nextcloud (WebDAV + localthumbs API).
// Requires ffmpeg/ffprobe on the PATH. Usage: npm test
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "localthumbs-e2e-"));
const LASTMOD = "Wed, 08 Jul 2026 10:00:00 GMT";

// --- 1. Generate a small test video ---

const video = path.join(work, "test.mp4");
const gen = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10", "-y", video]);
if (gen.status !== 0) {
    console.error("ffmpeg is required to run this test:", gen.stderr?.toString() || gen.error);
    process.exit(1);
}
const videoStat = fs.statSync(video);

// --- 2. Mock Nextcloud server ---

const state = {
    uploads: 0,
    uploadHadJpeg: false,
    propfindDepth1: 0,
};

function davEntry(href, isDir, size) {
    return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>
<d:getlastmodified>${LASTMOD}</d:getlastmodified>
${isDir ? "<d:resourcetype><d:collection/></d:resourcetype>" : `<d:resourcetype/><d:getcontentlength>${size}</d:getcontentlength><d:getcontenttype>video/mp4</d:getcontenttype>`}
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];

    if (req.method === "PROPFIND") {
        const depth = req.headers.depth;
        if (depth === "1") state.propfindDepth1++;
        req.resume();
        req.on("end", () => {
            const entries = [davEntry("/remote.php/dav/files/alice/", true)];
            if (depth === "1") entries.push(davEntry("/remote.php/dav/files/alice/test.mp4", false, videoStat.size));
            res.writeHead(207, { "Content-Type": "application/xml" });
            res.end(`<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:">\n${entries.join("\n")}\n</d:multistatus>`);
        });
        return;
    }

    if (req.method === "GET" && url === "/remote.php/dav/files/alice/test.mp4") {
        const range = req.headers.range;
        if (range) {
            const m = range.match(/bytes=(\d+)-(\d*)/);
            const start = parseInt(m[1]);
            const end = m[2] ? Math.min(parseInt(m[2]), videoStat.size - 1) : videoStat.size - 1;
            res.writeHead(206, {
                "Content-Range": `bytes ${start}-${end}/${videoStat.size}`,
                "Content-Length": end - start + 1,
                "Accept-Ranges": "bytes",
                "Content-Type": "video/mp4",
            });
            fs.createReadStream(video, { start, end }).pipe(res);
        } else {
            res.writeHead(200, { "Content-Length": videoStat.size, "Accept-Ranges": "bytes", "Content-Type": "video/mp4" });
            fs.createReadStream(video).pipe(res);
        }
        return;
    }

    if (url === "/ocs/v2.php/cloud/capabilities") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ocs: { data: { capabilities: { localthumbs: { version: "1.1.0", features: { batch_exists: true } } } } } }));
        return;
    }

    if (req.method === "POST" && url === "/index.php/apps/localthumbs/thumbnail/batchExists") {
        let body = "";
        req.on("data", d => body += d);
        req.on("end", () => {
            const results = {};
            for (const p of JSON.parse(body).paths) results[p] = state.uploads > 0;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "success", results }));
        });
        return;
    }

    if (req.method === "POST" && url === "/index.php/apps/localthumbs/thumbnail/upload") {
        const chunks = [];
        req.on("data", d => chunks.push(d));
        req.on("end", () => {
            state.uploads++;
            state.uploadHadJpeg = Buffer.concat(chunks).includes(Buffer.from([0xff, 0xd8, 0xff]));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "success", fileId: 123 }));
        });
        return;
    }

    res.writeHead(404);
    res.end("not found");
});

// --- 3. Worker config (multi-account mode with one account) ---

function writeConfig(port) {
    fs.mkdirSync(path.join(work, "accounts"));
    fs.writeFileSync(path.join(work, ".env"), [
        "NC_SECRET=e2esecret",
        "ACCOUNTS_DIR=./accounts",
        "CACHE_DIR=./cache",
        "TEMP_DIR=./tmp_thumbs",
    ].join("\n"));
    fs.writeFileSync(path.join(work, "accounts", "alice.env"), [
        `NC_URL=http://127.0.0.1:${port}/remote.php/dav/files/alice/`,
        "NC_USER=alice",
        "NC_PASS=secret",
    ].join("\n"));
}

// The mock server runs in this process, so the worker must be spawned
// asynchronously — a blocking spawnSync would deadlock the HTTP responses.
function runWorker() {
    return new Promise((resolve) => {
        const proc = spawn("node", [path.join(repoRoot, "index.js")], { cwd: work });
        let stdout = "", stderr = "";
        const timer = setTimeout(() => proc.kill("SIGKILL"), 120000);
        proc.stdout.on("data", d => stdout += d);
        proc.stderr.on("data", d => stderr += d);
        proc.on("close", (status) => {
            clearTimeout(timer);
            if (status !== 0) {
                console.error(stdout);
                console.error(stderr);
            }
            resolve({ status, stdout, stderr });
        });
    });
}

// --- 4. Run and assert ---

server.listen(0, "127.0.0.1", async () => {
    const port = server.address().port;
    writeConfig(port);
    let failed = false;

    try {
        const run1 = await runWorker();
        assert.strictEqual(run1.status, 0, "run 1: worker should exit 0");
        assert.strictEqual(state.uploads, 1, "run 1: exactly one thumbnail upload");
        assert.ok(state.uploadHadJpeg, "run 1: upload contains JPEG data");
        assert.match(run1.stdout, /Uploaded: 1/, "run 1: reports one upload");

        const thumbCache = fs.readFileSync(path.join(work, "cache", "alice.thumb_cache.csv"), "utf-8");
        assert.ok(thumbCache.includes("/test.mp4"), "thumb cache records the file");
        const folderCache = JSON.parse(fs.readFileSync(path.join(work, "cache", "alice.folder_cache.json"), "utf-8"));
        assert.ok(folderCache["/"], "folder cache has an entry for /");

        const run2 = await runWorker();
        assert.strictEqual(run2.status, 0, "run 2: worker should exit 0");
        assert.strictEqual(state.uploads, 1, "run 2: no re-upload");
        assert.strictEqual(state.propfindDepth1, 1, "run 2: folder cache skips the rescan");

        console.log("PASS: e2e test succeeded");
    } catch (e) {
        failed = true;
        console.error("FAIL:", e.message);
    } finally {
        server.close();
        fs.rmSync(work, { recursive: true, force: true });
        process.exit(failed ? 1 : 0);
    }
});
