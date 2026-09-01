import express from "express";
import ytDlp from "yt-dlp-exec";
import { generate } from "youtube-po-token-generator";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";
import axios from "axios";

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

// Helper: YouTube URL se Video ID extract karna
function extractYouTubeId(url) {
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
  return match ? match[1] : null;
}

// -------------------------------------------------------------
// INVIDIOUS BACKEND API INTEGRATION (Active Instance fetcher)
// -------------------------------------------------------------
async function extractViaInvidious(videoId) {
  try {
    console.log("🔍 Fetching active Invidious instances from api.invidious.io...");
    const instancesRes = await axios.get("https://api.invidious.io/instances.json?sort_by=health", { timeout: 5000 });
    const instances = instancesRes.data;

    // Sirf HTTPS aur API-enabled active instances ko filter karein
    const activeInstances = instances.filter(item => {
      const details = item[1];
      return details && details.api === true && details.type === "https" && details.health > 80;
    });

    for (const instance of activeInstances) {
      const domain = instance[0];
      const instanceUrl = `https://${domain}`;
      console.log(`📡 Trying Invidious Backend Instance: ${instanceUrl}`);

      try {
        const videoRes = await axios.get(`${instanceUrl}/api/v1/videos/${videoId}`, { timeout: 6000 });
        const data = videoRes.data;

        if (data && (data.formatStreams || data.adaptiveFormats)) {
          console.log(`✅ Invidious Backend Success from ${instanceUrl}`);
          
          const videos = [];
          const audios = [];

          // Combined Video + Audio streams
          if (data.formatStreams) {
            data.formatStreams.forEach((fmt) => {
              videos.push({
                format_id: fmt.container || "mp4",
                quality: fmt.qualityLabel || fmt.resolution || "Direct Stream",
                ext: fmt.container || "mp4",
                resolution: fmt.resolution || "N/A",
                file_size_mb: "Unknown",
                download_url: fmt.url
              });
            });
          }

          // Adaptive Video / Audio Streams
          if (data.adaptiveFormats) {
            data.adaptiveFormats.forEach((fmt) => {
              if (fmt.type && fmt.type.startsWith("video/")) {
                videos.push({
                  format_id: fmt.itag || "adaptive-video",
                  quality: fmt.qualityLabel || "Adaptive",
                  ext: fmt.container || "mp4",
                  resolution: fmt.resolution || "N/A",
                  file_size_mb: fmt.clen ? (parseInt(fmt.clen) / (1024 * 1024)).toFixed(2) : "Unknown",
                  download_url: fmt.url
                });
              } else if (fmt.type && fmt.type.startsWith("audio/")) {
                audios.push({
                  format_id: fmt.itag || "adaptive-audio",
                  ext: fmt.container || "m4a",
                  audio_bitrate: fmt.bitrate ? `${Math.round(fmt.bitrate / 1000)}kbps` : "N/A",
                  file_size_mb: fmt.clen ? (parseInt(fmt.clen) / (1024 * 1024)).toFixed(2) : "Unknown",
                  download_url: fmt.url
                });
              }
            });
          }

          return {
            status: "success",
            title: data.title || "YouTube Media Stream",
            thumbnail: data.videoThumbnails ? data.videoThumbnails[0]?.url : null,
            uploader: data.author || "Unknown",
            source_site: `Invidious (${domain})`,
            summary: {
              total_video_formats: videos.length,
              total_audio_formats: audios.length
            },
            data: {
              videos: videos,
              audios: audios
            }
          };
        }
      } catch (err) {
        console.warn(`⚠️ Instance ${instanceUrl} failed or timed out: ${err.message}`);
        continue; // Agle active instance par try karein
      }
    }
  } catch (error) {
    console.error("❌ Failed to fetch Invidious instances:", error.message);
  }
  return null;
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
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
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

// Root Route
app.get("/", (req, res) => {
  res.status(200).json({
    status: "online",
    message: "🚀 Media Extractor API is Live and Ready!",
    usage: "/extract?url=YOUR_VIDEO_URL"
  });
});

// Media Extraction Endpoint
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

    // 1. Pehle Invidious Backend Active Instances se try karo (agar YouTube link hai)
    if (isYouTube) {
      const videoId = extractYouTubeId(url);
      if (videoId) {
        const invidiousResult = await extractViaInvidious(videoId);
        if (invidiousResult) {
          return res.json(invidiousResult);
        }
      }
      console.log("⚠️ Invidious extraction missed/failed, falling back to yt-dlp...");
    }

    // 2. Fallback: yt-dlp + PO Token / Puppeteer logic
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

    if (fs.existsSync("./cookies.txt")) {
      options.cookies = "./cookies.txt";
    }

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

// Explicit host binding to 0.0.0.0 for Koyeb
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Extractor server running on port ${PORT}`));
