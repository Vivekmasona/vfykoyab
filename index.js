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

// Cloudflare / Anti-Bot Bypass
async function getCloudflareBypassData(targetUrl) {
  let browser = null;
  try {
    console.log(`🔍 Attempting Cloudflare bypass for: ${targetUrl}`);
    
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
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"
    );

    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise((resolve) => setTimeout(resolve, 4000));

    const userAgent = await page.evaluate(() => navigator.userAgent);
    const cookies = await page.cookies();
    
    await browser.close();

    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    console.log("✅ Cloudflare bypass successful!");

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
    const isInstagram = url.includes("instagram.com");

    const options = {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      referer: url,
      format: "b/best/bestvideo+bestaudio/all",
      addHeader: [
        'User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
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
    } else if (isInstagram) {
      // Instagram Mobile Client force karega taaki Muted DASH Video na aaye
      options.extractorArgs = "instagram:api_example=1";
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

        const hasVideo = fmt.vcodec && fmt.vcodec !== "none";
        const hasAudio = fmt.acodec && fmt.acodec !== "none";

        // Sirf Audio wahi pass hoga jisme Video na ho
        if (!hasVideo && hasAudio) {
          audios.push({
            format_id: fmt.format_id,
            ext: fmt.ext || "m4a",
            audio_bitrate: fmt.abr ? `${fmt.abr}kbps` : "N/A",
            file_size_mb: fmt.filesize ? (fmt.filesize / (1024 * 1024)).toFixed(2) : "Unknown",
            download_url: fmt.url
          });
        }

        // Video format processing
        if (hasVideo) {
          videos.push({
            format_id: fmt.format_id,
            quality: fmt.format_note || `${fmt.height || "unknown"}p`,
            ext: fmt.ext || "mp4",
            resolution: fmt.resolution || (fmt.width ? `${fmt.width}x${fmt.height}` : "N/A"),
            file_size_mb: fmt.filesize ? (fmt.filesize / (1024 * 1024)).toFixed(2) : "Unknown",
            has_audio: hasAudio,
            download_url: fmt.url
          });
        }
      });
    }

    // Direct Single Combined Stream Fallback
    if (videos.length === 0 && output.url) {
      videos.push({
        format_id: "best_combined",
        quality: "HD / Direct Stream",
        ext: output.ext || "mp4",
        has_audio: true,
        download_url: output.url
      });
    }

    // Audio Fallback: Audio array me wahi link jayegi jisme actual me audio present ho (`has_audio: true`)
    if (audios.length === 0 && videos.length > 0) {
      const audioAvailableVideo = videos.find((v) => v.has_audio === true);
      
      if (audioAvailableVideo) {
        audios.push({
          format_id: "audio_stream",
          ext: "m4a / mp3",
          audio_bitrate: "Original Stream Audio",
          file_size_mb: audioAvailableVideo.file_size_mb,
          download_url: audioAvailableVideo.download_url
        });
      }
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
