const express   = require("express");
const cors      = require("cors");
const path      = require("path");
const { spawn } = require("child_process");
const YTDlpWrap = require("yt-dlp-wrap").default;

const app   = express();
const PORT  = process.env.PORT || 3000;
const ytDlp = new YTDlpWrap(path.join(__dirname, "yt-dlp"));

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());

app.get("/", (req, res) => res.json({ status: "Grabify API running 🚀" }));

const SUPPORTED = [
  "instagram.com","instagr.am","facebook.com","fb.watch","fb.com",
  "tiktok.com","vm.tiktok.com","youtube.com","youtu.be",
  "twitter.com","x.com","pinterest.com","pin.it","vimeo.com"
];

// ─── /api/download — returns available quality info ────────────────────────
app.get("/api/download", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "No URL provided" });
  try { new URL(url); } catch { return res.status(400).json({ error: "Invalid URL" }); }
  if (!SUPPORTED.some(d => url.includes(d)))
    return res.status(400).json({ error: "Platform not supported" });

  console.log("[Download]", url);
  try {
    const metadata = await ytDlp.execPromise([
      url,
      "--dump-json",
      "--no-playlist",
      "--no-warnings",
      "--socket-timeout", "20"
    ]);

    const info    = JSON.parse(metadata);
    const formats = info.formats || [];
    const qualities = [];
    const seen = new Set();

    // Combined video+audio formats (guaranteed to have both streams)
    const combined = formats
      .filter(f => f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none" && f.url)
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    for (const f of combined) {
      const h = f.height || 0;
      if (h > 0 && !seen.has(h)) {
        seen.add(h);
        const label = h >= 2160 ? "4K" : h >= 1440 ? "2K" : `${h}p`;
        qualities.push({
          quality:    label,
          resolution: `${h}p`,
          ext:        "mp4",
          filesize:   f.filesize ? fmt(f.filesize) : null,
          hasAudio:   true
        });
      }
      if (qualities.length >= 4) break;
    }

    // Fallback: best available format with audio
    if (qualities.length === 0) {
      const best = formats
        .filter(f => f.url)
        .sort((a, b) => {
          const aA = a.acodec && a.acodec !== "none" ? 1 : 0;
          const bA = b.acodec && b.acodec !== "none" ? 1 : 0;
          if (bA !== aA) return bA - aA;
          return (b.height || 0) - (a.height || 0);
        });
      if (best[0]) {
        qualities.push({
          quality:    best[0].height ? `${best[0].height}p` : "HD",
          resolution: best[0].height ? `${best[0].height}p` : "HD",
          ext:        "mp4",
          filesize:   null,
          hasAudio:   true
        });
      }
    }

    // Audio-only entry
    const audio = formats
      .filter(f => f.vcodec === "none" && f.acodec && f.acodec !== "none" && f.url)
      .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
    if (audio) {
      qualities.push({
        quality:    "Audio",
        resolution: "mp3",
        ext:        "mp3",
        filesize:   audio.filesize ? fmt(audio.filesize) : null,
        hasAudio:   true
      });
    }

    if (qualities.length === 0)
      return res.status(500).json({ error: "No downloadable formats found." });

    return res.json({
      title:       info.title || "video",
      thumbnail:   info.thumbnail || null,
      platform:    info.extractor_key || "unknown",
      originalUrl: url,   // ← passed back so frontend can use /api/stream
      qualities
    });

  } catch (err) {
    console.error("[Error]", err.message);
    return res.status(500).json({ error: "Could not fetch video. It may be private or unsupported." });
  }
});

// ─── /api/stream — merges video+audio via yt-dlp and pipes to client ───────
// This is the REAL download endpoint. It solves the black-screen bug by
// letting yt-dlp merge streams server-side instead of sending raw CDN URLs.
app.get("/api/stream", async (req, res) => {
  const { url, quality, filename } = req.query;
  if (!url) return res.status(400).json({ error: "No URL provided" });
  if (!SUPPORTED.some(d => url.includes(d)))
    return res.status(400).json({ error: "Platform not supported" });

  // Map quality label → yt-dlp format string
  // NOTE: No [ext=mp4] restrictions — Facebook/Instagram don't always have mp4 formats
  // yt-dlp will merge to mp4 via --merge-output-format anyway
  const formatMap = {
    "4k":     "bestvideo[height<=2160]+bestaudio/bestvideo[height<=2160]/best[height<=2160]/best",
    "2k":     "bestvideo[height<=1440]+bestaudio/bestvideo[height<=1440]/best[height<=1440]/best",
    "1080p":  "bestvideo[height<=1080]+bestaudio/bestvideo[height<=1080]/best[height<=1080]/best",
    "720p":   "bestvideo[height<=720]+bestaudio/bestvideo[height<=720]/best[height<=720]/best",
    "480p":   "bestvideo[height<=480]+bestaudio/bestvideo[height<=480]/best[height<=480]/best",
    "hd":     "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
    "audio":  "bestaudio/best",
    "mp3":    "bestaudio/best",
    "default":"bestvideo+bestaudio/best"
  };

  const qualityKey = (quality || "default").toLowerCase();
  const isAudio    = qualityKey === "audio" || qualityKey === "mp3";
  const ytFormat   = formatMap[qualityKey] || formatMap["default"];
  const safeFile   = filename || (isAudio ? "grabify-audio.mp3" : "grabify-video.mp4");

  console.log("[Stream]", url, "quality:", qualityKey);

  try {
    res.setHeader("Content-Type", isAudio ? "audio/mpeg" : "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFile}"`);
    res.setHeader("Transfer-Encoding", "chunked");

    const args = [
      url,
      "-f", ytFormat,
      "--merge-output-format", isAudio ? "mp3" : "mp4",
      "-o", "-",           // output to stdout
      "--no-playlist",
      "--quiet",
      "--no-warnings",
      "--socket-timeout", "30"
    ];

    const proc = spawn(path.join(__dirname, "yt-dlp"), args);

    proc.stdout.pipe(res);

    proc.stderr.on("data", d => console.error("[yt-dlp]", d.toString().trim()));

    proc.on("error", err => {
      console.error("[Stream Error]", err.message);
      if (!res.headersSent) res.status(500).json({ error: "Stream failed" });
    });

    proc.on("close", code => {
      if (code !== 0) console.warn("[yt-dlp exited]", code);
    });

    // If client disconnects, kill the process
    req.on("close", () => {
      proc.kill("SIGKILL");
      console.log("[Stream] Client disconnected, killed yt-dlp");
    });

  } catch (err) {
    console.error("[Stream Error]", err.message);
    if (!res.headersSent)
      res.status(500).json({ error: "Stream failed: " + err.message });
  }
});

function fmt(b) {
  if (b > 1073741824) return (b / 1073741824).toFixed(1) + "GB";
  if (b > 1048576)    return (b / 1048576).toFixed(1) + "MB";
  if (b > 1024)       return (b / 1024).toFixed(1) + "KB";
  return b + "B";
}

app.listen(PORT, () => console.log("✅ Grabify API on port", PORT));
