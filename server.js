const express    = require("express");
const cors       = require("cors");
const { execFile } = require("child_process");
const path       = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

// Allow requests from your Grabify frontend
app.use(cors({
  origin: "*", // You can restrict this to your Render domain later
  methods: ["GET", "POST"]
}));

app.use(express.json());

// ---- Health check ----
app.get("/", (req, res) => {
  res.json({ status: "Grabify API is running 🚀" });
});

// ---- Download endpoint ----
// GET /api/download?url=VIDEO_URL
app.get("/api/download", (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "No URL provided" });
  }

  // Basic URL validation
  try { new URL(url); } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  // Only allow supported platforms
  const supported = [
    "instagram.com", "instagr.am",
    "facebook.com", "fb.watch", "fb.com",
    "tiktok.com", "vm.tiktok.com",
    "youtube.com", "youtu.be",
    "twitter.com", "x.com",
    "pinterest.com", "pin.it",
    "vimeo.com"
  ];

  const isSupported = supported.some(domain => url.includes(domain));
  if (!isSupported) {
    return res.status(400).json({ error: "Platform not supported" });
  }

  console.log(`[Download] Fetching: ${url}`);

  // Use yt-dlp to get video info + direct links
  const ytdlp = process.env.YTDLP_PATH || "./yt-dlp";
  execFile(ytdlp, [
    "--dump-json",
    "--no-playlist",
    "--no-warnings",
    "--socket-timeout", "15",
    url
  ], { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error("[yt-dlp error]", stderr);
      return res.status(500).json({ error: "Could not fetch video. The link may be private or unsupported." });
    }

    try {
      const info    = JSON.parse(stdout);
      const formats = info.formats || [];

      // Build quality options
      const qualities = [];

      // Get video+audio combined formats
      const videoFormats = formats
        .filter(f => f.vcodec !== "none" && f.acodec !== "none" && f.url)
        .sort((a, b) => (b.height || 0) - (a.height || 0));

      // Add unique resolutions
      const seenHeights = new Set();
      for (const f of videoFormats) {
        const h = f.height || 0;
        if (h > 0 && !seenHeights.has(h)) {
          seenHeights.add(h);
          let label = `${h}p`;
          if (h >= 2160) label = "4K";
          else if (h >= 1440) label = "2K";
          else if (h >= 1080) label = "1080p";
          else if (h >= 720)  label = "720p";
          else if (h >= 480)  label = "480p";
          else label = "SD";

          qualities.push({
            quality:    label,
            resolution: `${h}p`,
            url:        f.url,
            ext:        f.ext || "mp4",
            filesize:   f.filesize ? formatSize(f.filesize) : null
          });
        }
        if (qualities.length >= 4) break;
      }

      // If no combined formats, get best available
      if (qualities.length === 0) {
        const best = formats
          .filter(f => f.url)
          .sort((a, b) => (b.height || 0) - (a.height || 0));
        if (best[0]) {
          qualities.push({
            quality:    "HD",
            resolution: best[0].height ? `${best[0].height}p` : "HD",
            url:        best[0].url,
            ext:        best[0].ext || "mp4",
            filesize:   null
          });
        }
      }

      // Audio only (MP3)
      const audioFormat = formats
        .filter(f => f.vcodec === "none" && f.acodec !== "none" && f.url)
        .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

      if (audioFormat) {
        qualities.push({
          quality:    "Audio",
          resolution: "mp3",
          url:        audioFormat.url,
          ext:        "mp3",
          filesize:   audioFormat.filesize ? formatSize(audioFormat.filesize) : null
        });
      }

      if (qualities.length === 0) {
        return res.status(500).json({ error: "No downloadable formats found." });
      }

      return res.json({
        title:     info.title || "video",
        thumbnail: info.thumbnail || null,
        duration:  info.duration  || null,
        platform:  info.extractor_key || "unknown",
        qualities
      });

    } catch (parseErr) {
      console.error("[parse error]", parseErr);
      return res.status(500).json({ error: "Failed to parse video info." });
    }
  });
});

// ---- Format file size ----
function formatSize(bytes) {
  if (!bytes) return null;
  if (bytes > 1024*1024*1024) return (bytes/(1024*1024*1024)).toFixed(1)+"GB";
  if (bytes > 1024*1024)      return (bytes/(1024*1024)).toFixed(1)+"MB";
  if (bytes > 1024)           return (bytes/1024).toFixed(1)+"KB";
  return bytes+"B";
}

app.listen(PORT, () => {
  console.log(`✅ Grabify API running on port ${PORT}`);
});
