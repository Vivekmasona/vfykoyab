import express from "express";
import cors from "cors";
import axios from "axios";
import { generate } from "youtube-po-token-generator";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 8000;

// CORS setup - Sabhi domains access kar sakein
app.use(cors());
app.use(express.json());

// YouTube PO Token Cache System
let cachedPoToken = null;
let cachedVisitorData = null;
let lastFetchTime = 0;

async function getPoToken() {
  const currentTime = Date.now();
  // 6 ghante tak token cache rahega
  if (!cachedPoToken || currentTime - lastFetchTime > 6 * 60 * 60 * 1000) {
    try {
      const generated = await generate();
      cachedPoToken = generated.poToken;
      cachedVisitorData = generated.visitorData;
      lastFetchTime = currentTime;
      console.log("✅ New PO Token generated successfully via Puppeteer engine!");
    } catch (err) {
      console.error("⚠️ PO Token Generation Failed:", err.message);
    }
  }
  return { poToken: cachedPoToken, visitorData: cachedVisitorData };
}

// Helper: YouTube URL se Video ID nikalne ke liye
function extractYouTubeId(url) {
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
  return match ? match[1] : null;
}

// Invidious API se Audio URL extract karne ka logic
async function getAudioUrlFromInvidious(videoId) {
  try {
    console.log("🔍 Fetching active Invidious instances...");
    const instancesRes = await axios.get("https://api.invidious.io/instances.json?sort_by=health", { timeout: 5000 });
    
    // Filter active and healthy HTTPS instances
    const activeInstances = instancesRes.data.filter(item => {
      const details = item[1];
      return details && details.api === true && details.type === "https" && details.health > 70;
    });

    for (const instance of activeInstances) {
      const domain = instance[0];
      const instanceUrl = `https://${domain}`;
      console.log(`📡 Trying Invidious API: ${instanceUrl}`);

      try {
        const videoRes = await axios.get(`${instanceUrl}/api/v1/videos/${videoId}`, { timeout: 6000 });
        const data = videoRes.data;

        if (data && data.adaptiveFormats) {
          // Preferred Audio ITAGs prioritize karein (251 > 140 > 249 or any audio)
          const targetItags = ["251", "140", "249", "250"];
          let audioStream = null;

          for (const itag of targetItags) {
            audioStream = data.adaptiveFormats.find(fmt => String(fmt.itag) === String(itag));
            if (audioStream && audioStream.url) break;
          }

          // Agar specific itag na mile to koi bhi audio/ stream utha lo
          if (!audioStream) {
            audioStream = data.adaptiveFormats.find(fmt => fmt.type && fmt.type.startsWith("audio/"));
          }

          if (audioStream && audioStream.url) {
            console.log(`✅ Direct Audio Stream Found! (itag: ${audioStream.itag})`);
            return audioStream.url;
          }
        }
      } catch (err) {
        console.warn(`⚠️ Instance ${domain} failed: ${err.message}`);
        continue;
      }
    }
  } catch (error) {
    console.error("❌ Error fetching Invidious instances:", error.message);
  }
  return null;
}

// Health Check Endpoint
app.get("/", (req, res) => {
  res.status(200).json({
    status: "online",
    message: "🚀 Invidious Audio Redirector API is active!",
    usage: "/api?url=YOUR_YOUTUBE_URL"
  });
});

// Primary Endpoint (/api?url=...)
app.get("/api", async (req, res) => {
  let { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "URL query parameter is required. Example: /api?url=https://youtu.be/xxx" });
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  const videoId = extractYouTubeId(url);
  if (!videoId) {
    return res.status(400).json({ error: "Invalid YouTube URL provided." });
  }

  // Background mein PO Token generation trigger rakho
  getPoToken().catch(() => {});

  // Active Invidious backend se Direct Audio Link extract karein
  const audioPlaybackUrl = await getAudioUrlFromInvidious(videoId);

  if (audioPlaybackUrl) {
    // Directly Audio Stream URL par REDIRECT karein (HTTP 302)
    return res.redirect(302, audioPlaybackUrl);
  } else {
    return res.status(503).json({
      status: "error",
      message: "No active Invidious instance could return audio playback URL right now."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Audio Extractor API running on port ${PORT}`);
});
