import express from "express";
import cors from "cors";
import axios from "axios";
import { generate } from "youtube-po-token-generator";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

let cachedPoToken = null;
let cachedVisitorData = null;
let lastFetchTime = 0;

async function getPoToken() {
  const currentTime = Date.now();
  if (!cachedPoToken || currentTime - lastFetchTime > 4 * 60 * 60 * 1000) {
    let browser = null;
    try {
      console.log("⚙️ Generating Fresh PO Token via Puppeteer Stealth...");
      browser = await puppeteer.launch({
        headless: "new",
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-gpu",
          "--disable-extensions",
          "--js-flags=--max-old-space-size=128"
        ]
      });
      
      const generated = await generate(browser);
      cachedPoToken = generated.poToken;
      cachedVisitorData = generated.visitorData;
      lastFetchTime = currentTime;
      console.log("✅ PO Token Generated Successfully!");
    } catch (err) {
      console.error("⚠️ PO Token Generation Warning:", err.message);
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }
  return { poToken: cachedPoToken, visitorData: cachedVisitorData };
}

getPoToken().catch(() => {});

function extractYouTubeId(url) {
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
  return match ? match[1] : null;
}

async function getAudioUrlFromInvidious(videoId) {
  try {
    const instancesRes = await axios.get("https://api.invidious.io/instances.json?sort_by=health", { timeout: 5000 });
    const activeInstances = instancesRes.data.filter(item => {
      const details = item[1];
      return details && details.api === true && details.type === "https" && details.health > 70;
    });

    for (const instance of activeInstances) {
      const domain = instance[0];
      const instanceUrl = `https://${domain}`;

      try {
        const videoRes = await axios.get(`${instanceUrl}/api/v1/videos/${videoId}`, { timeout: 5000 });
        const data = videoRes.data;

        if (data && data.adaptiveFormats) {
          const targetItags = ["251", "140", "249", "250"];
          let audioStream = null;

          for (const itag of targetItags) {
            audioStream = data.adaptiveFormats.find(fmt => String(fmt.itag) === String(itag));
            if (audioStream && audioStream.url) break;
          }

          if (!audioStream) {
            audioStream = data.adaptiveFormats.find(fmt => fmt.type && fmt.type.startsWith("audio/"));
          }

          if (audioStream && audioStream.url) {
            return audioStream.url;
          }
        }
      } catch (err) {
        continue;
      }
    }
  } catch (error) {
    console.error("❌ API Fetch Error:", error.message);
  }
  return null;
}

app.get("/", (req, res) => {
  res.status(200).json({ status: "online", usage: "/api?url=YOUR_YOUTUBE_URL" });
});

app.get("/api", async (req, res) => {
  let { url } = req.query;

  if (!url) return res.status(400).json({ error: "URL param required" });
  if (!url.startsWith("http")) url = "https://" + url;

  const videoId = extractYouTubeId(url);
  if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL" });

  const audioPlaybackUrl = await getAudioUrlFromInvidious(videoId);

  if (audioPlaybackUrl) {
    return res.redirect(302, audioPlaybackUrl);
  } else {
    return res.status(503).json({ error: "No active instance returned playback URL" });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));
