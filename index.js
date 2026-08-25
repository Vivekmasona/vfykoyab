import express from "express";
import ytDlp from "yt-dlp-exec";
import { generate } from "youtube-po-token-generator";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

// Stealth plugin attach karein taaki Cloudflare bot detect na kar sake
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 8000;

// PO Token Caching
let cachedPoToken = null;
let cachedVisitorData = null;
let lastFetchTime = 0;

async function getPoToken() {
  const currentTime = Date.now();
  // Refresh PO Token every 6 hours
  if (!cachedPoToken || currentTime - lastFetchTime > 6 * 60 * 60 * 1000) {
    try {
      const generated = await generate();
      cachedPoToken = generated.poToken;
      cachedVisitorData = generated.visitorData;
      lastFetchTime = currentTime;
      console.log("✅ New YouTube PO Token generated successfully!");
    } catch (err) {
      console.error("⚠️ PO Token Generation Failed, proceeding without token:", err.message);
    }
  }
  return { poToken: cachedPoToken, visitorData: cachedVisitorData };
}

// Cloudflare Bypass Helper Function
async function getCloudflareBypassData(targetUrl) {
  let browser = null;
  try {
    console.log(`🔍 Attempting Cloudflare bypass for: ${targetUrl}`);
    
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null, // Docker/Koyeb environment support
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", // Low RAM environment fix for Docker
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process", // Memory optimization for Koyeb Free Tier
        "--disable-blink-features=AutomationControlled"
      ]
    });

    const page = await browser.newPage();
    
    // Modern Browser User-Agent Set Karein
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    // Target page open karein
    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 30000 });
    
    // Cloudflare Challenge Solve hone ke liye Wait Time (4 seconds)
    await new Promise((resolve) => setTimeout(resolve, 4000));

    const userAgent = await page.evaluate(() => navigator.userAgent);
    const cookies = await page.cookies();
    
    await browser.close();

    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    console.log("✅ Cloudflare bypass successful! Retreived bypass headers.");

    return { userAgent, cookieString };
  } catch (error) {
    if (browser) await browser.close();
    console.error("❌ Cloudflare bypass failed:", error.message);
    return null;
  }
}

app.get("/extract", async (req, res) => {
  let { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "URL query parameter required (?url=https://...)" });
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  try {
    const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");

    const options = {
      dumpSingleJson: true,
      noWarnings: true,
      referer: url,
      impersonate: "chrome" // TLS Fingerprint bypass
    };

    if (isYouTube) {
      const { poToken, visitorData } = await getPoToken();
      options.extractorArgs = "youtube:player_client=web,mweb,ios";

      if (poToken && visitorData) {
        options.extractorArgs += `;po_token=web+${poToken}`;
        options.headers = `Visitor-Data:${visitorData}`;
      }
    } else {
      // Direct HTTP fetch fail hone par Cloudflare Bypass Trigger karein
      const bypassData = await getCloudflareBypassData(url);
      if (bypassData && bypassData.cookieString) {
        options.addHeader = [
          `User-Agent:${bypassData.userAgent}`,
          `Cookie:${bypassData.cookieString}`
        ];
      }
    }

    const output = await ytDlp(url, options);

    const videos = [];
    const audios = [];

    if (output.formats && Array.isArray(output.formats)) {
      output.formats.forEach((fmt) => {
        if (!fmt.url) return;

        if (fmt.vcodec && fmt.vcodec !== "none") {
          videos.push({
            format_id: fmt.format_id,
            quality: fmt.format_note || `${fmt.height || "unknown"}p`,
            ext: fmt.ext,
            resolution: fmt.resolution || (fmt.width ? `${fmt.width}x${fmt.height}` : "N/A"),
            file_size_mb: fmt.filesize ? (fmt.filesize / (1024 * 1024)).toFixed(2) : "Unknown",
            download_url: fmt.url
          });
        } else if (fmt.acodec && fmt.acodec !== "none") {
          audios.push({
            format_id: fmt.format_id,
            ext: fmt.ext,
            audio_bitrate: fmt.abr ? `${fmt.abr}kbps` : "N/A",
            file_size_mb: fmt.filesize ? (fmt.filesize / (1024 * 1024)).toFixed(2) : "Unknown",
            download_url: fmt.url
          });
        }
      });
    }

    if (videos.length === 0 && output.url) {
      videos.push({
        format_id: "best",
        quality: "HD / Direct Stream",
        ext: output.ext || "mp4",
        download_url: output.url
      });
    }

    return res.json({
      status: "success",
      title: output.title || output.fulltitle || "Media Stream",
      thumbnail: output.thumbnail || null,
      uploader: output.uploader || "Unknown",
      source_site: output.extractor_key || "Universal Engine",
      summary: {
        total_video_formats: videos.length,
        total_audio_formats: audios.length
      },
      data: {
        videos: videos.reverse(),
        audios: audios.reverse()
      }
    });

  } catch (err) {
    return res.status(500).json({
      status: "error",
      message: "Extraction failed.",
      details: err.message
    });
  }
});

app.listen(PORT, () => console.log(`🚀 Extractor server running on port ${PORT}`));
