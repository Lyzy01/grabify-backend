const YTDlpWrap = require("yt-dlp-wrap").default;
const path = require("path");

async function install() {
  try {
    console.log("Downloading yt-dlp binary...");
    await YTDlpWrap.downloadFromGithub(path.join(__dirname, "yt-dlp"));
    console.log("yt-dlp installed successfully!");
  } catch (err) {
    console.error("Failed to install yt-dlp:", err.message);
    // Don't fail the build — server will handle missing binary gracefully
  }
}

install();
