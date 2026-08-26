import express from "express";
import ytDlp from "yt-dlp-exec";
import { generate } from "youtube-po-token-generator";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 8000;

// YouTube PO Token Cache
let cachedPoToken = null;
let cachedVisitorData = null;
let lastFetchTime = 0;

async function getPoToken() {
  const currentTime = Date.now();
  if (!cachedPoToken || currentTime - lastFetchTime > 6 * 60 * 60 * 1000) {
    try {
      const generated = await generate();
      cachedPoToken = generated.poToken;
      cachedVisitorData = generated.visitorData;
      lastFetchTime = currentTime;
      console.log("✅ New PO Token generated successfully!");
    } catch (err) {
      console.error("⚠️ PO Token Generation Failed:", err.message);
    }
  }
  return { poToken: cachedPoToken, visitorData: cachedVisitorData };
}

// Browser Bypass
async function getCloudflareBypassData(targetUrl) {
  let browser = null;
  try {
    console.log(`🔍 Attempting browser bypass for: ${targetUrl}`);
    
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-blink-features=AutomationControlled"
      ]
    });

    const page = await browser.newPage();
    
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const userAgent = await page.evaluate(() => navigator.userAgent);
    const cookies = await page.cookies();
    
    await browser.close();

    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    console.log("✅ Bypass successful!");

    return { userAgent, cookieString };
  } catch (error) {
    if (browser) await browser.close();
    console.error("❌ Bypass failed:", error.message);
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
      noCheckCertificates: true,
      referer: url,
      addHeader: [
        'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language:en-US,en;q=0.9'
      ]
    };

    if (isYouTube) {
      const { poToken, visitorData } = await getPoToken();
      options.extractorArgs = "youtube:player_client=web,mweb,ios";

      if (poToken && visitorData) {
        options.extractorArgs += `;po_token=web+${poToken}`;
        options.headers = `Visitor-Data:${visitorData}`;
      }
    } else {
      const bypassData = await getCloudflareBypassData(url);
      if (bypassData && bypassData.cookieString) {
        options.addHeader.push(`Cookie:${bypassData.cookieString}`);
        if (bypassData.userAgent) {
          options.addHeader[0] = `User-Agent:${bypassData.userAgent}`;
        }
      }
    }

    const output = await ytDlp(url, options);

    const videos = [];
    const audios = [];

    if (output.formats && Array.isArray(output.formats)) {
      output.formats.forEach((fmt) => {
        if (!fmt.url) return;

        // DASH videos ko detect karne ka strict logic
        const isDash = fmt.format_id && fmt.format_id.includes("dash");
        const hasVideo = fmt.vcodec && fmt.vcodec !== "none";
        const hasAudio = fmt.acodec && fmt.acodec !== "none" && !isDash;

        if (hasVideo) {
          videos.push({
            format_id: fmt.format_id,
            quality: fmt.format_note || `${fmt.height || "unknown"}p`,
            ext: fmt.ext || "mp4",
            resolution: fmt.resolution || (fmt.width ? `${fmt.width}x${fmt.height}` : "N/A"),
            file_size_mb: fmt.filesize ? (fmt.filesize / (1024 * 1024)).toFixed(2) : "Unknown",
            has_audio: hasAudio, // DASH me strictly false jayega
            download_url: fmt.url
          });
        }

        if (hasAudio && !hasVideo) {
          audios.push({
            format_id: fmt.format_id,
            ext: fmt.ext || "m4a",
            audio_bitrate: fmt.abr ? `${fmt.abr}kbps` : "N/A",
            file_size_mb: fmt.filesize ? (fmt.filesize / (1024 * 1024)).toFixed(2) : "Unknown",
            download_url: fmt.url
          });
        }
      });
    }

    // Direct Progressive Stream (Non-DASH)
    if (output.url && !output.url.includes("dash")) {
      videos.unshift({
        format_id: "best_progressive",
        quality: "HD Direct Stream",
        ext: output.ext || "mp4",
        has_audio: true,
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
        videos: videos,
        audios: audios
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
