const express  = require("express");
const cors     = require("cors");
const path     = require("path");
const YTDlpWrap = require("yt-dlp-wrap").default;

const app  = express();
const PORT = process.env.PORT || 3000;
const ytDlp = new YTDlpWrap(path.join(__dirname, "yt-dlp"));

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "Grabify API is running 🚀" });
});

const SUPPORTED = [
  "instagram.com","instagr.am","facebook.com","fb.watch","fb.com",
  "tiktok.com","vm.tiktok.com","youtube.com","youtu.be",
  "twitter.com","x.com","pinterest.com","pin.it","vimeo.com"
];

app.get("/api/download", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "No URL provided" });
  try { new URL(url); } catch { return res.status(400).json({ error: "Invalid URL" }); }
  if (!SUPPORTED.some(d => url.includes(d))) return res.status(400).json({ error: "Platform not supported" });

  console.log("[Download]", url);
  try {
    const info = await ytDlp.getVideoInfo(url);
    const formats = info.formats || [];
    const qualities = [];
    const seen = new Set();

    const vids = formats.filter(f => f.vcodec !== "none" && f.acodec !== "none" && f.url)
                        .sort((a,b) => (b.height||0)-(a.height||0));
    for (const f of vids) {
      const h = f.height||0;
      if (h > 0 && !seen.has(h)) {
        seen.add(h);
        let label = h>=2160?"4K":h>=1440?"2K":`${h}p`;
        qualities.push({ quality:label, resolution:`${h}p`, url:f.url, ext:f.ext||"mp4", filesize:f.filesize?fmt(f.filesize):null });
      }
      if (qualities.length>=4) break;
    }

    if (qualities.length===0) {
      const best = formats.filter(f=>f.url).sort((a,b)=>(b.height||0)-(a.height||0));
      if (best[0]) qualities.push({ quality:"HD", resolution:best[0].height?`${best[0].height}p`:"HD", url:best[0].url, ext:best[0].ext||"mp4", filesize:null });
    }

    const audio = formats.filter(f=>f.vcodec==="none"&&f.acodec!=="none"&&f.url).sort((a,b)=>(b.abr||0)-(a.abr||0))[0];
    if (audio) qualities.push({ quality:"Audio", resolution:"mp3", url:audio.url, ext:"mp3", filesize:audio.filesize?fmt(audio.filesize):null });

    if (qualities.length===0) return res.status(500).json({ error:"No downloadable formats found." });

    return res.json({ title:info.title||"video", thumbnail:info.thumbnail||null, platform:info.extractor_key||"unknown", qualities });
  } catch(err) {
    console.error("[Error]", err.message);
    return res.status(500).json({ error:"Could not fetch video. It may be private or unsupported." });
  }
});

function fmt(b) {
  if (b>1073741824) return (b/1073741824).toFixed(1)+"GB";
  if (b>1048576)    return (b/1048576).toFixed(1)+"MB";
  if (b>1024)       return (b/1024).toFixed(1)+"KB";
  return b+"B";
}

app.listen(PORT, () => console.log("Grabify API on port", PORT));
