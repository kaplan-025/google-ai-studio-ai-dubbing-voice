import ytSearch from 'yt-search';
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { Readable } from "stream";
import iconv from "iconv-lite";
import fetch, { Response } from "node-fetch";
import * as Extractors from "./extractors";
import * as SibnetExtractor from "./sibnetExtractor";
import { browserManager } from "./browserManager";
import { BrowserContext, Page } from "playwright";
import { metricsManager } from "./metricsManager";
import { extractionCache } from "./resultCache";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Set Cross-Origin Isolation headers for FFmpeg
  app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  });

  app.use(express.json());

  const config = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  };

  // Use the shared Sibnet cookie cache from the extractor module
  const sibnetCookieCache = SibnetExtractor.sibnetCookieCache;

  const getRandomIP = () => Array.from({length: 4}, () => Math.floor(Math.random() * 256)).join('.');

  const isInvalidResponse = (res: any) => !res || !res.ok || res.status === 400 || res.status === 403 || res.status === 503;

  const isSibnetHost = (url: string) => url.includes('sibnet.ru') || url.includes('dv.sibnet.ru');

  const fetchWithTimeout = async (url: string, options: any = {}, timeout = 15000) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    
    // Inject random IP headers for extraction/proxy to help bypass blocks
    if (options.headers && !options.headers['X-Forwarded-For']) {
      const ip = getRandomIP();
      options.headers['X-Forwarded-For'] = ip;
      options.headers['X-Real-IP'] = ip;
    }

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(id);
      return response;
    } catch (error) {
      clearTimeout(id);
      throw error;
    }
  };

  const fetchWithRetry = async (url: string, options: any = {}, timeout = 15000, retries = 2) => {
    for (let i = 0; i < retries; i++) {
      try {
        // Increase timeout on each retry
        const currentTimeout = timeout + (i * 10000);
        const res = await fetchWithTimeout(url, options, currentTimeout);
        if (res.status === 500 && i < retries - 1) {
            console.warn(`Fetch returned 500 for ${url}, retrying (${i + 1}/${retries})...`);
            await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));                
            continue;
        }
        return res;
      } catch (error) {
        if (i === retries - 1) throw error;
        console.warn(`Fetch failed for ${url}, retrying (${i + 1}/${retries})...`, error instanceof Error ? error.message : String(error));
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
    throw new Error("Fetch failed after retries");
  };

        // Regex fallback patterns from Method 2 (Less reliable for direct use, mainly for diagnostic/fallback)
        const patterns = [
          // Sibnet Specific (Prioritized)
          /https?:\/\/[a-z0-9-]+\.sibnet\.ru\/[0-9/]+\.mp4\?[^"']*(?:st|e|stor)=[^"']+/i,
          /\?st=[a-zA-Z0-9_-]+&e=\d+&stor=\d+&noip=1/i,
          /player\.src\(\[\s*{\s*src\s*:\s*["']([^"']+\.mp4(?:\?[^"']+)?)["']/i,
          /src:\s*["']?(\/v\/[^"'>\s]+\.mp4(?:\?[^"']+)?)["']?/i,
          
          // Generic Patterns
          /video\.src\s*=\s*['"]([^'"]+)['"]/,
          /["']playable_url["']\s*:\s*["']([^"']+)["']/,
          /["']browser_native_hd_url["']\s*:\s*["']([^"']+)["']/,
          /["']browser_native_sd_url["']\s*:\s*["']([^"']+)["']/,
          /property="og:video" content="([^"]+)"/,
          /property="og:video:url" content="([^"]+)"/,
          /property="og:video:secure_url" content="([^"]+)"/,
          /src:\s*['"]([^'"]+\.mp4[^'"]*)['"]/,
          /source\s+src=['"]([^'"]+)['"]/,
          /['"]player['"]\s*:\s*\{[^}]*['"]file['"]\s*:\s*['"]([^'"]+)['"]/,
          /file\s*:\s*['"]([^'"]+\.mp4[^'"]*)['"]/,
          /["']file["']\s*:\s*["']([^"']+\.mp4[^'"]*)["']/i,
          /["']file["']\s*:\s*["'](\/v\/[^"']+)["']/,
          /setVideo\s*\(\s*\{[^}]*url\s*:\s*['"]([^'"]+)['"]/,
          /setVideo\s*\(\s*\{[^}]*slug\s*:\s*['"]([^'"]+)['"]/,
          /slug\s*:\s*['"]([^'"]+\.mp4[^'"]*)['"]/i,
          /"src"\s*:\s*"([^"]+)"/i,
          /src\s*:\s*"([^"]+)"/i,
          /src\s*:\s*'([^']+)'/i,
          /video_url\s*:\s*"([^"]+)"/i,
          /url\s*:\s*['"]([^'"]+\.mp4[^'"]*)['"]/i,
          /link\s*:\s*['"]([^'"]+\.mp4[^'"]*)['"]/i,
          /"link"\s*:\s*"([^"]+)"/
        ];



  const searchCache = new Map<string, { videos: any[], timestamp: number }>();
  const SEARCH_CACHE_TTL = 300000; // 5 minutes

  // API route for YouTube Search
  app.get("/api/youtube/search", async (req, res) => {
    const { q } = req.query;
    if (!q || typeof q !== 'string') return res.status(400).json({ error: "Query is required" });

    try {
      const cached = searchCache.get(q);
      if (cached && Date.now() - cached.timestamp < SEARCH_CACHE_TTL) {
        console.log(`YouTube Search Cache HIT: ${q}`);
        return res.json({ videos: cached.videos });
      }

      console.log(`YouTube Search Request: ${q}`);
      const results = await ytSearch(q);
      const videos = results.videos.slice(0, 20).map(v => ({
        id: v.videoId,
        url: v.url,
        title: v.title,
        thumbnail: v.thumbnail,
        duration: v.timestamp,
        author: v.author.name,
        views: v.views,
        ago: v.ago
      }));
      
      searchCache.set(q, { videos, timestamp: Date.now() });
      res.json({ videos });
    } catch (e: any) {
      console.error("YouTube search error:", e);
      res.status(500).json({ error: "Failed to search YouTube", details: e.message });
    }
  });

  // Simple Proxy for YouTube Thumbnails to avoid CORS
  app.get("/api/proxy/image", async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== 'string') return res.status(400).send("URL required");
    try {
      const response = await fetch(url);
      if (!response.ok) return res.status(response.status).send("Failed to fetch image");
      const contentType = response.headers.get("content-type");
      if (contentType) res.setHeader("Content-Type", contentType);
      const buffer = await response.buffer();
      res.send(buffer);
    } catch (e) {
      res.status(500).send("Proxy error");
    }
  });

  // API route for video extraction
  app.post("/api/extract", async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') return res.status(400).json({ error: "URL is required" });

    const trimmedUrl = url.trim();
    if (!trimmedUrl.startsWith('http')) {
      return res.status(400).json({ error: "Invalid URL format. Must start with http:// or https://" });
    }

    try {
      // Clean URL: remove tracking parameters
      let cleanUrl = trimmedUrl;
      try {
        const urlObj = new URL(url);
        const paramsToRemove = ['fbclid', 'utm_source', 'utm_medium', 'utm_campaign', 'si', 'ref', 'app'];
        paramsToRemove.forEach(p => urlObj.searchParams.delete(p));
        cleanUrl = urlObj.toString();
      } catch (e) {}

      console.log(`Extracting video from: ${cleanUrl} (Original: ${url})`);
      
      const normalizeUrl = (baseUrl: string, extractedUrl: string): string | null => {
        if (!extractedUrl) return null;
        
        let normalized = extractedUrl
          .replace(/\\u0026/g, "&")
          .replace(/\\u002F/g, "/")
          .replace(/&amp;/g, "&")
          .replace(/\\/g, "");

        if (normalized.startsWith("//")) return "https:" + normalized;
        if (normalized.startsWith("http")) return normalized;
        
        if (normalized.startsWith("/")) {
          try {
            const base = new URL(baseUrl);
            // Special handling for Sibnet relative paths
            const finalBase = baseUrl.includes("sibnet.ru") ? "https://video.sibnet.ru" : `${base.protocol}//${base.host}`;
            return `${finalBase}${normalized}`;
          } catch (e) {
            return null;
          }
        }
        return null;
      };

      const isLikelyVideo = (url: string) => {
        const lower = url.toLowerCase();
        
        // Filter out DASH partial fragments (often video-only or audio-only probe chunks)
        // Stronger filtering for common Instagram DASH patterns
        const partialKeywords = ['bytestart=', 'byteend=', 'range=', 'seg-', 'fragment', 'bitrate='];
        if (partialKeywords.some(k => lower.includes(k))) return false;
        
        // Filter out known audio-only tracks in DASH
        if (lower.includes('audio_only') || lower.includes('dash_audio') || lower.includes('/audio/')) {
          // Unless it's explicitly an m4a/mp3 that we might want to pair later (not yet supported)
          if (!lower.includes('.mp4')) return false;
        }
        
        // Direct video extensions - check if it's in the path
        const extensions = ['mp4', 'm3u8', 'webm', 'mov', 'm4v', 'avi', 'flv', 'wmv'];
        const hasExtension = extensions.some(ext => lower.includes(`.${ext}`));
        
        if (hasExtension) {
          // Exclude certain known page types that might contain extensions in URL but are not videos
          if (lower.includes("facebook.com/watch") || lower.includes("facebook.com/share") || lower.includes("youtube.com/watch")) {
            return false;
          }
          return true;
        }

        // Special case for Sibnet: page URLs often contain "video" but are not direct links
        if (lower.includes("sibnet.ru/video") && !lower.includes("/v/")) {
          return false;
        }
        
        // Sibnet CDN links
        if (lower.includes('sibnet.ru') && (lower.includes('.mp4') || lower.includes('/v/'))) return true;
        
        // Instagram/FB CDN URLs
        if (lower.includes('fbcdn.net') || lower.includes('cdninstagram.com')) return true;

        // Avoid picking up known page patterns as video URLs
        if (lower.includes("/reel/") || lower.includes("/reels/") || lower.includes("/share/") || lower.includes("/p/") || lower.includes("/tv/") || lower.includes("drive.google.com") || lower.includes("docs.google.com")) {
          // Unless it explicitly has a video extension or is a direct download/CDN link
          if (!hasExtension && !lower.includes("export=download") && !lower.includes("fbcdn.net") && !lower.includes("cdninstagram.com")) {
            return false;
          }
        }
        
        // CDNs
        const isCDN = lower.includes("fbcdn.net") || lower.includes("cdninstagram.com") || lower.includes("googlevideo.com") || lower.includes("tiktokcdn.com");
        
        // Common video API keywords
        const isVideoApi = lower.includes("playable_url") || lower.includes("youtube.com/videoplayback") || (lower.includes("video") && !lower.includes("sibnet.ru") && !lower.includes("facebook.com")) || lower.includes("export=download");
        
        return hasExtension || isCDN || isVideoApi;
      };

      // Check if it's already a direct video link
      if (isLikelyVideo(cleanUrl)) {
        console.log("URL looks like a direct link, performing quick verification...");
        const verifyHeaders: any = { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
        };
        if (cleanUrl.includes('sibnet.ru')) {
          verifyHeaders['Referer'] = 'https://video.sibnet.ru/';
        }

        try {
          const verifyRes = await fetch(cleanUrl, { 
            method: 'HEAD', 
            headers: verifyHeaders,
            signal: AbortSignal.timeout(6000)
          });
          const contentType = verifyRes.headers.get('content-type');
          if (contentType && (contentType.includes('video/') || contentType.includes('application/x-mpegURL') || contentType.includes('application/vnd.apple.mpegurl'))) {
            console.log("Direct link verified via HEAD:", contentType);
            return res.json({ videoUrl: cleanUrl });
          }
          
          // If HEAD fails or is not helpful (some servers don't like HEAD), try a minimal GET
          verifyHeaders['Range'] = 'bytes=0-1024';
          const verifyGet = await fetch(cleanUrl, { 
            headers: verifyHeaders,
            signal: AbortSignal.timeout(6000)
          });
          const getContentType = verifyGet.headers.get('content-type');
          if (getContentType && (getContentType.includes('video/') || getContentType.includes('application/x-mpegURL') || getContentType.includes('application/vnd.apple.mpegurl'))) {
            console.log("Direct link verified via GET:", getContentType);
            return res.json({ videoUrl: cleanUrl });
          }
          
          console.log("URL returned non-video content type:", getContentType);
          // Fall through to extraction if it's just a page
        } catch (e) {
          console.warn("Direct link verification failed, falling through to extraction:", e instanceof Error ? e.message : String(e));
        }
      }

      let html = "";
      let sibHtml = ""; // Declare here for broader scope
      let finalUrl = cleanUrl;
      let videoUrl: string | null = null;
      let metadata: any = {};
      const isInstagram = cleanUrl.includes("instagram.com");
      const isTikTok = cleanUrl.includes("tiktok.com");
      const isFacebook = cleanUrl.includes("facebook.com") || cleanUrl.includes("fb.watch");
      const isSibnet = cleanUrl.includes("sibnet.ru");
      const sibnetId = SibnetExtractor.extractSibnetId(cleanUrl);
      const isYouTube = cleanUrl.includes("youtube.com") || cleanUrl.includes("youtu.be");
      const isDrive = cleanUrl.includes("drive.google.com") || cleanUrl.includes("docs.google.com");

      try {
        if (isSibnet) {
          // Skip initial fetch for Sibnet as it's often blocked and handled by specialized extractor
          console.log(`Delegating Sibnet URL directly to specialized extractor: ${cleanUrl}`);
          const result = await SibnetExtractor.extractSibnet(cleanUrl);
          if (result && result.videoUrl) {
            videoUrl = result.videoUrl;
            if (result.metadata) metadata = { ...metadata, ...result.metadata };
            return res.json({ videoUrl, metadata });
          }
          
          // If specialized failed, return special flag to frontend
          console.warn(`Sibnet specialized extraction failed for ${cleanUrl}.`);
          return res.json({ error: "Sibnet validation failed.", escalate: true });
        } else {
          // MOBILE SIMULATION for Instagram/TikTok/FB
          const useMobile = isInstagram || isTikTok || isFacebook;
          const userAgent = useMobile 
            ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
            : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

          const fetchHeaders: any = {
              'User-Agent': userAgent,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
              'Sec-Fetch-Dest': 'document',
              'Sec-Fetch-Mode': 'navigate',
              'Sec-Fetch-Site': 'none',
              'Upgrade-Insecure-Requests': '1'
          };
          if (isInstagram) {
            fetchHeaders['Referer'] = 'https://www.instagram.com/';
            fetchHeaders['Origin'] = 'https://www.instagram.com';
          } else if (isFacebook) {
            fetchHeaders['Referer'] = 'https://www.facebook.com/';
          }

          const response = await fetch(cleanUrl, {
            headers: fetchHeaders,
            redirect: 'follow'
          });
          finalUrl = response.url || cleanUrl;
          html = await response.text();
        }
        console.log(`Fetched HTML length: ${html.length}, Final URL: ${finalUrl}`);
      } catch (e: any) {
        console.error("Initial fetch failed:", e.message);
      }

      if (finalUrl.includes("facebook.com") || finalUrl.includes("fb.watch") || cleanUrl.includes("facebook.com") || cleanUrl.includes("fb.watch")) {
        // Handle Reels and Videos specifically
        let reelId = null;
        const targetUrl = finalUrl.includes("facebook.com") ? finalUrl : cleanUrl;
        
        if (targetUrl.includes("/reel/") || targetUrl.includes("/reels/")) {
          reelId = targetUrl.split(/\/reels?\//)[1]?.split("/")[0]?.split("?")[0];
        } else if (targetUrl.includes("/videos/")) {
          reelId = targetUrl.split("/videos/")[1]?.split("/")[0]?.split("?")[0];
        } else if (targetUrl.includes("v=")) {
          try {
             reelId = new URL(targetUrl).searchParams.get("v");
          } catch(e) {
             const m = targetUrl.match(/[?&]v=(\d+)/);
             if (m) reelId = m[1];
          }
        } else if (targetUrl.match(/\/(\d+)\/?(?:\?|$)/)) {
          // Sometimes it's just facebook.com/user/videos/12345
          const m = targetUrl.match(/\/videos\/(\d+)/) || targetUrl.match(/\/(\d+)\/?(?:\?|$)/);
          if (m) reelId = m[1];
        }

        if (reelId) {
          console.log(`Detected Facebook Video/Reel ID: ${reelId}`);
          // Try to fetch the embed page as it's often easier to scrape
          try {
            const videoLink = `https://www.facebook.com/watch/?v=${reelId}`;
            const embedUrl = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(videoLink)}&show_text=0&width=560`;
            console.log(`Trying Facebook embed extraction: ${embedUrl}`);
            
            const embedResponse = await fetch(embedUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Referer': 'https://www.facebook.com/'
              }
            });
            const embedHtml = await embedResponse.text();
            
            const embedPatterns = [
              /video_url":"([^"]+)"/,
              /hd_src":"([^"]+)"/,
              /sd_src":"([^"]+)"/,
              /playable_url":"([^"]+)"/,
              /playable_url_quality_hd":"([^"]+)"/,
              /hd_src_no_ratelimit":"([^"]+)"/,
              /sd_src_no_ratelimit":"([^"]+)"/,
              /"src":"([^"]+)"/
            ];

            for (const pattern of embedPatterns) {
              const match = embedHtml.match(pattern);
              if (match && match[1]) {
                const candidate = normalizeUrl(targetUrl, match[1].replace(/\\/g, ""));
                if (candidate && isLikelyVideo(candidate)) {
                  videoUrl = candidate;
                  console.log("Found video URL in Facebook embed page");
                  break;
                }
              }
            }
          } catch (e) {
            console.error("Facebook embed fetch failed", e);
          }
        }

        if (!videoUrl) {
          // Look for various FB video source patterns in the main page
          const patterns = [
            /hd_src":"([^"]+)"/,
            /sd_src":"([^"]+)"/,
            /property="og:video" content="([^"]+)"/,
            /property="og:video:url" content="([^"]+)"/,
            /property="og:video:secure_url" content="([^"]+)"/,
            /"browser_native_hd_url":"([^"]+)"/,
            /"browser_native_sd_url":"([^"]+)"/,
            /video_url":"([^"]+)"/,
            /playable_url":"([^"]+)"/,
            /playable_url_quality_hd":"([^"]+)"/,
            /"dash_manifest":"([^"]+)"/,
            /manifest_url":"([^"]+)"/,
            /"video":\{"url":"([^"]+)"/,
            /src\\":\\"([^"]+?\.mp4[^"]*?)\\"/,
            /video_url\\":\\"(https:[^"]+)\\"/,
            /hd_src_no_ratelimit":"([^"]+)"/,
            /sd_src_no_ratelimit":"([^"]+)"/
          ];
          
          for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
              const candidate = normalizeUrl(targetUrl, match[1].replace(/\\/g, ""));
              if (candidate && isLikelyVideo(candidate)) {
                videoUrl = candidate;
                console.log(`Found video URL in main page using pattern: ${pattern.toString().substring(0, 30)}...`);
                break;
              }
            }
          }
        }
      }
 else if (cleanUrl.includes("instagram.com")) {
        // Look for IG video source patterns
        const patterns = [
          /property="og:video" content="([^"]+)"/,
          /property="og:video:url" content="([^"]+)"/,
          /property="og:video:secure_url" content="([^"]+)"/,
          /"video_versions":\[\{"type":\d+,"url":"([^"]+)"/,
          /"video_url":"([^"]+)"/,
          /"video_dash_manifest":"([^"]+)"/,
          /video_src":"([^"]+)"/,
          /display_url":"([^"]+)"/,
          /src\\":\\"([^"]+?\.mp4[^"]*?)\\"/,
          /video_id":"([^"]+)"/,
          /"playable_url":"([^"]+)"/,
          /"contentUrl":"([^"]+)"/
        ];

        for (const pattern of patterns) {
          const match = html.match(pattern);
          if (match && match[1]) {
            const candidate = normalizeUrl(cleanUrl, match[1]);
            if (candidate && isLikelyVideo(candidate)) {
              videoUrl = candidate;
              break;
            }
          }
        }
      } else if (cleanUrl.includes("youtube.com") || cleanUrl.includes("youtu.be")) {
        console.log("Detected YouTube URL");
        // YouTube is handled primarily by fallbacks (Cobalt, etc.)
      }

      if (!videoUrl) {
        // Try to find any URL ending in .mp4 in the HTML as a last resort
        const mp4Match = html.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
        if (mp4Match) {
          const candidate = normalizeUrl(cleanUrl, mp4Match[0]);
          if (candidate && isLikelyVideo(candidate)) {
            videoUrl = candidate;
          }
        }
      }

      if (!videoUrl) {
        // Try to extract from JSON objects in script tags
        const jsonMatches = html.match(/\{"__typename":"[^"]+",.*?\}/g);
        if (jsonMatches) {
          for (const jsonStr of jsonMatches) {
            try {
              const data = JSON.parse(jsonStr);
              const candidate = normalizeUrl(cleanUrl, data.playable_url || data.video_url || data.hd_src || data.sd_src);
              if (candidate && isLikelyVideo(candidate)) {
                videoUrl = candidate;
                console.log("Found video URL in JSON object");
                break;
              }
            } catch (e) {}
          }
        }
      }

      if (videoUrl) {
        // Extra validation for Sibnet: must be a signed CDN link
        if (isSibnet && videoUrl.includes('sibnet.ru') && !videoUrl.includes('st=') && !videoUrl.includes('dvb') && !videoUrl.includes('dv')) {
          console.warn(`Initial Sibnet extraction returned non-functional path: ${videoUrl}. Will try fallbacks...`);
          videoUrl = null;
        }
      }

      if (videoUrl) {
        console.log(`Found video URL: ${videoUrl}`);
        
        const sourceHtml = sibHtml || html;
        if (sourceHtml && sourceHtml.length > 200) {
          const titleMatch = sourceHtml.match(/<title>([^<]+)<\/title>/i) || sourceHtml.match(/meta property="og:title" content="([^"]+)"/i);
          const descMatch = sourceHtml.match(/meta name="description" content="([^"]+)"/i) || sourceHtml.match(/meta property="og:description" content="([^"]+)"/i);
          if (titleMatch) metadata.title = titleMatch[1].replace(" - Sibnet video", "").trim();
          if (descMatch) metadata.description = descMatch[1].trim();
          
          // Try to get upload date if available (common in meta tags)
          const dateMatch = sourceHtml.match(/meta property="og:updated_time" content="([^"]+)"/i) || sourceHtml.match(/meta property="article:published_time" content="([^"]+)"/i);
          if (dateMatch) metadata.date = dateMatch[1];
        }

        res.json({ videoUrl, metadata });
      } else {
        // If regex fails, try a few public extraction fallbacks with a timeout
        const fetchJSON = async (url: string, options: any = {}, retries = 2, silent = false, noProxy = false) => {
          let lastErr: any;
          const proxies = !noProxy ? [
            (u: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
            (u: string) => `https://cors-anywhere.herokuapp.com/${u}`,
            (u: string) => `https://thingproxy.freeboard.io/fetch/${u}`,
            (u: string) => `https://proxy.cors.sh/${u}`,
            (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
            (u: string) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
            (u: string) => `https://cors-proxy.htmldriven.com/?url=${encodeURIComponent(u)}`,
            (u: string) => `https://api.proxyscrape.com/v2/?request=get&url=${encodeURIComponent(u)}`,
            (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`
          ] : [];

          for (let i = 0; i <= retries; i++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s per-fetch timeout

            try {
              let targetUrl = url;
              if (i === retries && lastErr && targetUrl.startsWith("https://")) {
                targetUrl = targetUrl.replace("https://", "http://");
              }

              const res = await fetchWithTimeout(targetUrl, {
                ...options,
                signal: options.signal || controller.signal,
                headers: {
                  'User-Agent': i % 2 === 0 
                    ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
                    : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
                  'Accept': 'application/json, text/plain, */*',
                  'Origin': new URL(url).origin,
                  'Referer': new URL(url).origin + '/',
                  ...options.headers
                }
              });
              clearTimeout(timeoutId);
              
              if (!res.ok) {
                if (!silent) console.warn(`HTTP error ${res.status} for ${url}`);
                let errorText = "";
                try { errorText = await res.text(); } catch (e) {}
                
                if (res.status === 401 || res.status === 403) {
                  throw new Error(`Auth/Access denied for ${url}`);
                }

                const urlMatch = errorText.match(/https?:\/\/[^"'\s<>]+?\.(mp4|m3u8|webm|mov|m4v|avi|flv|wmv)[^"'\s<>]*/i);
                if (urlMatch) return { url: urlMatch[0] };

                throw new Error(`HTTP ${res.status}`);
              }
              
              const text = await res.text();
              if (text.startsWith("http") && text.length < 1000) return { url: text.trim() };
              
              try {
                return JSON.parse(text);
              } catch (e) {
                const urlMatch = text.match(/https?:\/\/[^"'\s<>]+?\.(mp4|m3u8|webm|mov|m4v|avi|flv|wmv)[^"'\s<>]*/i);
                if (urlMatch) return { url: urlMatch[0] };
                
                if (i === retries) return {};
                continue;
              }
            } catch (e: any) {
              clearTimeout(timeoutId);
              lastErr = e;
              
              // Broad network error check
              const isNetworkError = e instanceof TypeError || 
                                   e.name === 'AbortError' || 
                                   e.message?.includes('fetch failed') || 
                                   e.message?.includes('network') ||
                                   e.code === 'ECONNREFUSED' ||
                                   e.code === 'ENOTFOUND';

              if (isNetworkError && !noProxy) {
                if (!silent) console.warn(`Direct fetch failed for ${url}, trying proxies...`);
                for (const proxyFn of proxies) {
                  try {
                    await new Promise(r => setTimeout(r, 300 + Math.random() * 500));
                    const proxyUrl = proxyFn(url);
                    const pController = new AbortController();
                    const pTimeout = setTimeout(() => pController.abort(), 20000); // Increased to 20s
                    
                    // If it's a POST request, some proxies might not support it easily
                    // but we'll try to pass the method and body if the proxy supports it.
                    const proxyOptions: any = { 
                      signal: pController.signal,
                      headers: { 
                        'x-cors-proxy-user-agent': 'Mozilla/5.0',
                        'Accept': 'application/json'
                      }
                    };

                    // If the original request was a POST, try to use proxies that support POST
                    if (options.method === "POST") {
                      // Many proxies now support POST if we pass the right headers or if they are simple relayers
                      if (proxyUrl.includes("cors-anywhere") || proxyUrl.includes("thingproxy") || 
                          proxyUrl.includes("corsproxy.io") || proxyUrl.includes("codetabs") || 
                          proxyUrl.includes("cors.sh")) {
                        proxyOptions.method = "POST";
                        proxyOptions.body = options.body;
                        proxyOptions.headers['Content-Type'] = 'application/json';
                      } else {
                        // For GET-only proxies, we can't really proxy a POST request effectively 
                        // unless the proxy has a specific way to handle it.
                        // We'll skip POST for GET-only proxies to avoid 405/400 errors.
                        continue;
                      }
                    }
                    
                    const proxyRes = await fetch(proxyUrl, proxyOptions);
                    clearTimeout(pTimeout);
                    
                    if (proxyRes.ok) {
                      const text = await proxyRes.text();
                      let contents = text;
                      
                      // If the response is a direct URL, return it
                      if (contents.trim().startsWith("http") && contents.trim().length < 1000 && !contents.includes("<html")) {
                        return { url: contents.trim() };
                      }

                      if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
                        try {
                          const data = JSON.parse(text);
                          contents = data.contents || (typeof data === 'string' ? data : JSON.stringify(data));
                        } catch (e) {}
                      }
                      if (contents) {
                        if (typeof contents === 'string' && (contents.trim().startsWith('{') || contents.trim().startsWith('['))) {
                          try { return JSON.parse(contents); } catch (e) {}
                        }
                        if (typeof contents === 'object') return contents;
                        const urlMatch = contents.match(/https?:\/\/[^"'\s<>]+?\.(mp4|m3u8|webm|mov|m4v|avi|flv|wmv)[^"'\s<>]*/i);
                        if (urlMatch) return { url: urlMatch[0] };
                      }
                    }
                  } catch (proxyErr) {}
                }
              }

              if (i < retries) {
                await new Promise(r => setTimeout(r, 1000 + (i * 1000)));
                continue;
              }
            }
          }
          throw lastErr;
        };

        const directFetch = async (signal: AbortSignal) => {
          try {
            console.log(`Attempting direct extraction from: ${cleanUrl}`);
            
            const fetchWithProxy = async (targetUrl: string): Promise<string> => {
              try {
                const r = await fetch(targetUrl, {
                  headers: {
                    'User-Agent': config.userAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': 'https://www.google.com/',
                    'Sec-CH-UA': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
                    'Sec-CH-UA-Mobile': '?0',
                    'Sec-CH-UA-Platform': '"Windows"',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'cross-site',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1'
                  },
                  signal
                });
                
                if (r.status === 429) {
                  throw new Error("HTTP 429 (Rate Limited by Instagram)");
                }

                if (r.ok) {
                  const html = await r.text();
                  if (html.includes('/accounts/login/')) {
                    console.warn("Instagram returned a login page redirect.");
                    return ""; // Return empty to trigger next fallback
                  }
                  return html;
                }
                throw new Error(`HTTP ${r.status}`);
              } catch (e) {
                // Try one proxy as fallback for HTML
                console.warn(`Direct HTML fetch failed: ${e instanceof Error ? e.message : String(e)}, trying proxy fallback...`);
                const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
                const pr = await fetch(proxyUrl, { signal });
                if (pr.ok) {
                  const json = await pr.json();
                  return json.contents || "";
                }
                throw e;
              }
            };

            const text = await fetchWithProxy(cleanUrl);
            
            if (cleanUrl.includes("youtube.com") || cleanUrl.includes("youtu.be")) {
              // More robust YouTube JSON extraction
              const jsonPatterns = [
                /ytInitialPlayerResponse\s*=\s*({.+?});\s*(?:var|window|head)/,
                /ytInitialPlayerResponse\s*=\s*({.+?});/,
                /ytInitialPlayerResponse\s*=\s*({.+?})$/m,
                /"playerResponse":\s*({.+?})\s*,\s*"captions"/
              ];

              let playerResponse = null;
              for (const pattern of jsonPatterns) {
                const match = text.match(pattern);
                if (match && match[1]) {
                  try {
                    playerResponse = JSON.parse(match[1]);
                    break;
                  } catch (e) {
                    // Try cleaning the string if it has trailing junk
                    try {
                      let cleaned = match[1].trim();
                      if (cleaned.endsWith(';')) cleaned = cleaned.slice(0, -1);
                      playerResponse = JSON.parse(cleaned);
                      break;
                    } catch (e2) {}
                  }
                }
              }

              if (playerResponse) {
                const streamingData = playerResponse.streamingData || {};
                const formats = [...(streamingData.formats || []), ...(streamingData.adaptiveFormats || [])];
                
                // Prioritize non-ciphered URLs first
                const bestFormat = formats
                  .filter((f: any) => f.url && f.mimeType?.includes("video/mp4"))
                  .sort((a: any, b: any) => (b.width || 0) - (a.width || 0))[0];

                if (bestFormat && bestFormat.url) return bestFormat.url;
                
                // If all are ciphered, we'd need a signature decrypter (complex)
                // Fallback to searching for any direct googlevideo links in the text
              }
              
              const videoUrls = text.match(/https?:\/\/[^"\\ ]+?googlevideo\.com\/videoplayback[^"\\ ]+/g);
              if (videoUrls) {
                for (const vUrl of videoUrls) {
                  const decoded = vUrl.replace(/\\u0026/g, "&").replace(/\\/g, "");
                  if (decoded.includes("mime=video%2Fmp4")) return decoded;
                }
              }
            }

            const patterns = [
              /property="og:video" content="([^"]+)"/,
              /property="og:video:url" content="([^"]+)"/,
              /property="og:video:secure_url" content="([^"]+)"/,
              /property="twitter:player:stream" content="([^"]+)"/,
              /name="twitter:player:stream" content="([^"]+)"/,
              /property="twitter:image" content="([^"]+\.mp4[^"]*)"/,
              /"video_url":"([^"]+)"/,
              /"contentUrl":"([^"]+)"/,
              /source src="([^"]+\.(mp4|m3u8|webm|mov|m4v|avi|flv|wmv)[^"]*)"/,
              /<video[^>]+src="([^"]+)"/,
              /data-video-url="([^"]+)"/,
              /data-src="([^"]+\.(mp4|m3u8|webm|mov|m4v|avi|flv|wmv)[^"]*)"/,
              /playable_url":"([^"]+)"/,
              /sd_src":"([^"]+)"/,
              /hd_src":"([^"]+)"/,
              /"browser_native_sd_url":"([^"]+)"/,
              /"browser_native_hd_url":"([^"]+)"/,
              /video_url\\":\\"(https:[^"]+)\\"/,
              /display_url\\":\\"(https:[^"]+)\\"/,
              /https?:\/\/[^"'\s<>]+?\.(mp4|m3u8|webm|mov|m4v|avi|flv|wmv)[^"'\s<>]*/i,
               /player\.src\(\[\{src:\s*"([^"]+)"/
            ];

            for (const pattern of patterns) {
              const match = text.match(pattern);
              if (match && match[1]) {
                const candidate = match[1].replace(/\\u0026/g, "&").replace(/\\/g, "");
                if (candidate.startsWith("http")) return candidate;
              } else if (match && match[0] && match[0].startsWith("http")) {
                return match[0];
              }
            }
            return null;
          } catch (e) {
            console.warn("Direct extraction failed:", e instanceof Error ? e.message : String(e));
            return null;
          }
        };

        const cobaltExtract = async (url: string, signal: AbortSignal): Promise<string | null> => {
          // Priority list of mirrors that are often more stable
          const mirrors = [
            "cobalt.bcit.cc", "royal.cobalt.tools", "im.cobalt.tools", 
            "api.cobalt.tools", "cobalt.sh", "co.wuk.sh",
            "cobalt.vve.pw", "cobalt.lonelil.com", "cobalt.0x5.dev"
          ].sort(() => Math.random() - 0.5);

          // Only try a few mirrors to stay within timeout
          const maxMirrors = 5;
          for (let i = 0; i < Math.min(mirrors.length, maxMirrors); i++) {
            const domain = mirrors[i];
            // Cobalt v10 (main instance) uses / instead of /api/json (v7)
            const endpoints = ["/", "/api/json"];
            
            for (const endpoint of endpoints) {
              try {
                console.log(`Trying Cobalt mirror #${i+1}: ${domain}${endpoint}`);
                
                const payloads = [
                  { url, videoQuality: "720" },
                  { url, videoQuality: "1080" },
                  { url, downloadMode: "video" } 
                ];
                
                for (const payload of payloads) {
                  try {
                    const res = await fetchWithTimeout(`https://${domain}${endpoint}`, {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                      },
                      body: JSON.stringify(payload),
                      signal,
                    }, 10000);

                    if (!res.ok) {
                      if (res.status === 404 || res.status === 405) continue; // Try next endpoint
                      throw new Error(`HTTP ${res.status}`);
                    }

                    const data = await res.json();
                    
                    // Cobalt v10 success: { status: 'stream', url: '...' } or { status: 'picker', picker: [...] }
                    // Cobalt v7 success: { url: '...' } or { picker: [...] }
                    const directUrl = data.url || (data.picker?.[0]?.url) || (data.picker?.[0]?.video) || (data.status === 'stream' && data.url);
                    
                    if (directUrl) {
                      console.log(`Cobalt success via ${domain}${endpoint}`);
                      return directUrl;
                    }
                    
                    if (data.status === 'error') {
                      console.warn(`Cobalt error from ${domain}: ${data.text}`);
                      if (data.text?.includes('rate')) break; 
                    }
                  } catch (e) {
                    // Try next payload or endpoint
                  }
                }
              } catch (e) {
                // Try next mirror
              }
            }
          }
          return null;
        };

        const instagramPlaywrightExtract = async (url: string, signal: AbortSignal): Promise<string | null> => {
          console.log("Launching Playwright for Instagram extraction via BrowserManager...");
          
          const uas = [
            'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
            'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
          ];
          const ua = uas[Math.floor(Math.random() * uas.length)];

          return await browserManager.withPage(async (page, context) => {
            await context.setExtraHTTPHeaders({
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
              'Sec-Fetch-Dest': 'document',
              'Sec-Fetch-Mode': 'navigate',
              'Sec-Fetch-Site': 'none',
              'Upgrade-Insecure-Requests': '1',
              'Referer': 'https://www.google.com/'
            });

            // Set up stealth script
            await context.addInitScript(() => {
              Object.defineProperty(navigator, 'webdriver', { get: () => false });
              (navigator as any).plugins = [1, 2, 3, 4, 5];
              Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            });

            let videoUrl: string | null = null;
            
            page.on('response', (response: any) => {
              const u = response.url();
              const headers = response.headers();
              const contentType = headers['content-type'] || '';
              const cl = headers['content-length'];
              
              const isVideo = contentType.includes('video/') || u.includes('.mp4');
              const partialKeywords = ['bytestart=', 'byteend=', 'range=', 'seg-', 'fragment', 'bitrate='];
              const isPartial = partialKeywords.some(k => u.toLowerCase().includes(k));
              
              if (isVideo && !isPartial) {
                if (cl && parseInt(cl) > 1000000) {
                  console.log(`Detected valid media stream: ${u.substring(0, 50)}... (${(parseInt(cl)/1024/1024).toFixed(2)} MB)`);
                  videoUrl = u;
                } else if (!videoUrl) {
                  videoUrl = u;
                }
              }
            });

            try {
              await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
              const content = await page.content();
              if (content.includes('login') && content.includes('accounts/login')) {
                console.warn("Instagram login wall detected.");
                await page.evaluate(() => window.scrollTo(0, 400));
              } else {
                await page.evaluate(() => {
                  window.scrollTo(0, 500);
                  const video = document.querySelector('video');
                  if (video) {
                    video.play().catch(() => {});
                    video.muted = true;
                  }
                });
                await page.waitForTimeout(3000);
              }
            } catch (e) {
              console.warn("Playwright page load error:", e instanceof Error ? e.message : String(e));
            }

            if (videoUrl) return videoUrl;

            return await page.evaluate(() => {
              const selectors = ['meta[property="og:video"]', 'meta[property="og:video:secure_url"]', 'meta[name="twitter:player:stream"]'];
              for (const s of selectors) {
                const el = document.querySelector(s);
                if (el && (el as any).content) return (el as any).content;
              }
              const video = document.querySelector('video');
              if (video && video.src && video.src.startsWith('http')) return video.src;
              
              const scripts = Array.from(document.querySelectorAll('script'));
              for (const script of scripts) {
                const text = script.textContent || '';
                if (text.includes('video_url')) {
                  const m = text.match(/"video_url":"([^"]+)"/);
                  if (m && m[1]) return m[1].replace(/\\u0026/g, '&');
                }
              }
              return null;
            }).catch(() => null);
          }, { userAgent: ua });
        };

        const fallbacks = [
          // 1. YouTube Specific (YT-DLP Style Web Extractors)
          ...(isYouTube ? [
            // Pro-active Cobalt usage (High success rate, centralized)
            (signal: AbortSignal) => Extractors.extractViaCobalt(cleanUrl, signal),
            async (signal: AbortSignal) => {
              // Loader.to API (Very reliable)
              const videoId = cleanUrl.match(/(?:v=|\/v\/|embed\/|youtu\.be\/|shorts\/)([^?&/]+)/)?.[1];
              if (!videoId) return null;
              const data = await fetchJSON(`https://p.oceansaver.in/ajax/download.php?button=1&start=1&end=1&format=720&url=${encodeURIComponent(cleanUrl)}`, { signal });
              if (data.success && data.id) {
                // Poll for progress (max 5 attempts)
                for (let i = 0; i < 5; i++) {
                  await new Promise(r => setTimeout(r, 2000));
                  const progress = await fetchJSON(`https://p.oceansaver.in/ajax/progress.php?id=${data.id}`, { signal });
                  if (progress.success && progress.download_url) return progress.download_url;
                }
              }
              return null;
            },
            async (signal: AbortSignal) => {
              // Y2Mate API v1 (Reliable for YouTube)
              const data = await fetchJSON(`https://api.y2mate.is/v1/analyze?url=${encodeURIComponent(cleanUrl)}`, { signal });
              return data.url || data.video_url || (data.links && data.links.mp4 && data.links.mp4[0] && data.links.mp4[0].url);
            }
          ] : []),

          // Platform-specific prioritized extractors
          ...(isSibnet ? [
            (signal: AbortSignal) => Extractors.extractViaCobalt(cleanUrl, signal),
          ] : []),
          ...(isDrive ? [
            async (signal: AbortSignal) => {
              console.log("Detected Google Drive URL, converting to direct link...");
              const fileIdMatch = cleanUrl.match(/\/d\/([^/]+)/) || 
                                 cleanUrl.match(/id=([^&]+)/) ||
                                 cleanUrl.match(/\/file\/d\/([^/]+)/);
              
              if (fileIdMatch && fileIdMatch[1]) {
                const fileId = fileIdMatch[1].split('/')[0].split('?')[0];
                const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
                
                try {
                  // First, try to fetch the direct URL to see if it gives us a confirmation page
                  const res = await fetch(directUrl, { signal });
                  const contentType = res.headers.get('content-type');
                  
                  if (contentType && contentType.includes('text/html')) {
                    const html = await res.text();
                    // Look for the confirmation token in the HTML
                    // Pattern 1: confirm=XXXX
                    // Pattern 2: name="confirm" value="XXXX"
                    // Pattern 3: id="confirm" value="XXXX"
                    const confirmMatch = html.match(/confirm=([a-zA-Z0-9_]+)/) || 
                                         html.match(/name="confirm" value="([a-zA-Z0-9_]+)"/) ||
                                         html.match(/id="confirm" value="([a-zA-Z0-9_]+)"/);
                                         
                    if (confirmMatch && confirmMatch[1]) {
                      const finalUrl = `${directUrl}&confirm=${confirmMatch[1]}`;
                      console.log(`Found Drive confirmation token, generated link: ${finalUrl}`);
                      return finalUrl;
                    }
                    console.log("Drive returned HTML but no confirmation token found. HTML snippet:", html.substring(0, 500));
                  }
                  
                  // If it's not HTML or we didn't find a token, just return the direct URL
                  return directUrl;
                } catch (e) {
                  console.warn("Error during Drive token extraction, falling back to direct URL", e);
                  return directUrl;
                }
              }
              console.log("Failed to extract File ID from Drive URL");
              return null;
            }
          ] : []),
          
          ...(isYouTube ? [
            directFetch,
            // These often work better than Cobalt for YouTube recently
            async (signal: AbortSignal) => {
              // Vevioz API (YouTube specific)
              const videoIdMatch = cleanUrl.match(/(?:v=|\/v\/|embed\/|youtu\.be\/|shorts\/)([^?&/]+)/);
              if (videoIdMatch) {
                const data = await fetchJSON(`https://api.vevioz.com/api/button/videos/${videoIdMatch[1]}`, { signal });
                return data.url || data.video_url;
              }
              return null;
            },
            async (signal: AbortSignal) => {
              // Social-Downloader (YouTube mirror)
              const data = await fetchJSON(`https://social-downloader.com/api/extract?url=${encodeURIComponent(cleanUrl)}`, { signal });
              return data.url || data.video_url || data.data?.url;
            },
            async (signal: AbortSignal) => {
              // SnapAny (YouTube mirror)
              const data = await fetchJSON(`https://api.snapany.com/api/extract?url=${encodeURIComponent(cleanUrl)}`, { signal });
              return data.url || data.video_url || data.data?.url;
            },
            async (signal: AbortSignal) => {
              // SSSTik (YouTube mirror)
              const data = await fetchJSON(`https://ssstik.io/api/download?url=${encodeURIComponent(cleanUrl)}`, { signal });
              return data.url || data.video_url;
            },
            async (signal: AbortSignal) => {
              // Publer (Works well for YouTube)
              const data = await fetchJSON("https://publer.io/api/v1/social-media-downloader", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: cleanUrl }),
                signal
              });
              return data.payload?.[0]?.path || data.payload?.[0]?.url;
            }
          ] : []),
          
          ...(isInstagram ? [
            (signal: AbortSignal) => Extractors.extractViaCobalt(cleanUrl, signal),
            (signal: AbortSignal) => Extractors.extractInstagram(cleanUrl, signal),
            async (signal: AbortSignal) => {
              // Social-Downloader API (Keep one as fallback)
              const data = await fetchJSON(`https://social-downloader.com/api/extract?url=${encodeURIComponent(cleanUrl)}`, { signal });
              return data.url || data.video_url || data.data?.url;
            }
          ] : []),
          
          ...(isTikTok ? [
            (signal: AbortSignal) => Extractors.extractViaCobalt(cleanUrl, signal),
            async (signal: AbortSignal) => {
              const data = await fetchJSON(`https://api.tiklydown.eu.org/api/download?url=${encodeURIComponent(cleanUrl)}`, { signal });
              return data.video?.noWatermark || data.video?.url || data.data?.video?.no_watermark;
            }
          ] : []),
 
          ...(isFacebook ? [
            (signal: AbortSignal) => Extractors.extractFacebook(cleanUrl, signal),
            (signal: AbortSignal) => Extractors.extractViaCobalt(cleanUrl, signal),
            async (signal: AbortSignal) => {
              // Social-Downloader API
              const data = await fetchJSON(`https://social-downloader.com/api/extract?url=${encodeURIComponent(cleanUrl)}`, { signal });
              return data.url || data.video_url || data.data?.url;
            }
          ] : []),

          // Savetwitter (Now called SaveFrom/SaveTube) - Try only a few versions to prevent mass timeouts
          ...["v01", "v03", "v05"].map(v => async (signal: AbortSignal) => {
            const data = await fetchJSON(`https://api.${v}.savetwitter.com/api/v1/extract?url=${encodeURIComponent(cleanUrl)}`, { signal }, 1, true); 
            return data.video_url || data.url || (data.data && data.data.url);
          }),
          
          // Direct fetch (If not already tried)
          ...(!isYouTube ? [directFetch] : [])
        ];

        let lastError = "";
        let attemptCount = 0;
        for (const fallbackFn of fallbacks) {
          attemptCount++;
          try {
            console.log(`Trying extraction fallback #${attemptCount}...`);
            // Small delay between attempts to avoid rate limits
            if (attemptCount > 1) {
              const jitter = Math.random() * 800;
              await new Promise(resolve => setTimeout(resolve, 1200 + jitter));
            }

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout
            
            const resultUrl = await fallbackFn(controller.signal);
            clearTimeout(timeout);
            
            if (resultUrl && typeof resultUrl === 'string') {
               const normalized = normalizeUrl(url, resultUrl);
               if (normalized && isLikelyVideo(normalized)) {
                 // Extra validation for Sibnet: must be a signed CDN link
                 if (isSibnet && normalized.includes('sibnet.ru') && !normalized.includes('st=') && !normalized.includes('dvb') && !normalized.includes('dv')) {
                   console.warn(`Fallback #${attemptCount} returned non-functional Sibnet path: ${normalized}. Continuing...`);
                   continue;
                 }
                 
                 console.log(`Found video URL via fallback: ${normalized}`);
                 return res.json({ videoUrl: normalized });
               }
            }
          } catch (e: any) {
             const errBase = e.name === 'AbortError' ? 'Timeout' : (e.message || String(e));
             // Filter out HTML strings from errors to keep logs clean
             const cleanErr = errBase.includes('<!doctype') || errBase.includes('<html') 
               ? "Upstream service returned malformed response (likely rate limited or blocked)."
               : errBase;
             
             lastError = cleanErr;
             // Use warn instead of error for individual fallback failures as they are expected
             console.warn(`Fallback #${attemptCount} failed: ${cleanErr}`);
          }
        }
        
        res.status(404).json({ 
          error: "Could not extract video URL.",
          details: lastError,
          suggestion: "The video might be private, restricted, or the link is invalid. Try downloading the video and uploading it manually."
        });
      }
    } catch (error) {
      console.error("Extraction error:", error);
      res.status(500).json({ error: "Internal server error during extraction" });
    }
  });

  // Proxy route for video files to bypass CORS
  app.get("/api/proxy", async (req, res) => {
    const { url, originalUrl } = req.query;
    if (!url || typeof url !== 'string') return res.status(400).json({ error: "URL is required" });

    if (!url.startsWith('http')) {
      console.error(`Invalid proxy URL: ${url}`);
      return res.status(400).json({ error: `Invalid URL format: ${url}. Must be absolute.` });
    }

    try {
      const isSibnet = url.includes('sibnet.ru');
      let targetUrl = url;
      
      // Safety block for known non-functional Sibnet format
      if (isSibnet && targetUrl.includes('/v/') && !targetUrl.includes('st=')) {
        console.warn(`Initial check for Sibnet path: ${targetUrl}. Missing ST token.`);
      }

      // Add noip=1 to Sibnet URLs to bypass IP-linked token checks on their CDNs
      if (isSibnet && !targetUrl.includes('noip=1')) {
        targetUrl += (targetUrl.includes('?') ? '&' : '?') + 'noip=1';
      }

      let sibnetReferer = 'https://video.sibnet.ru/';
      let sibnetId = SibnetExtractor.extractSibnetId(targetUrl);
      
      let defaultReferer = '';
      if (isSibnet) {
        // Fix ID extraction: prioritize the digits before .mp4 for direct links
        if (sibnetId) {
          // Analysis suggests original page is a high-integrity referer
          if (originalUrl && typeof originalUrl === 'string' && originalUrl.includes('sibnet.ru')) {
            sibnetReferer = originalUrl;
          } else {
            // Fallback to video page if we have a viable ID
            sibnetReferer = `https://video.sibnet.ru/video${sibnetId}`;
          }
        } else if (targetUrl.includes('sibnet.ru')) {
          sibnetReferer = (originalUrl && typeof originalUrl === 'string' && originalUrl.includes('sibnet.ru')) 
            ? originalUrl 
            : 'https://video.sibnet.ru/';
        }
        defaultReferer = sibnetReferer;
      } else {
        try {
          const u = new URL(url);
          defaultReferer = `${u.protocol}//${u.hostname}/`;
          if (url.includes('sendvid.com')) defaultReferer = 'https://sendvid.com/';
          if (url.includes('instagram.com') || url.includes('fbcdn.net') || url.includes('cdninstagram.com')) {
            defaultReferer = 'https://www.instagram.com/';
          }
        } catch(e) {}
      }
      
      const getHeaders = (referer: string | boolean = true, withRange = true, minimal = false, userAgentType = 'desktop') => {
        // Use the minimalist UA from the successful Python POC
        let ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
        if (userAgentType === 'mobile') {
          ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1';
        }

        const h: Record<string, string> = {
          'User-Agent': ua
        };

        if (isSibnet) {
          h['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0';
          h['Referer'] = 'https://video.sibnet.ru/';
          if (referer === true && defaultReferer) h['Referer'] = defaultReferer;
          else if (typeof referer === 'string') h['Referer'] = referer;
          
          h['Accept'] = '*/*';
          h['Accept-Language'] = 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7';
          // Removed X-Requested-With for direct CDN files as it can trigger 400 Bad Request
          h['Accept-Encoding'] = 'identity';
          
          const sid = sibnetId || SibnetExtractor.extractSibnetId(url);
          const cache = sid ? (sibnetCookieCache.get(sid) || "") : "";
          if (cache) h['Cookie'] = cache;
          
          if (withRange && req.headers.range) {
            h['Range'] = req.headers.range;
          }
          return h; // Return early for Sibnet - strictly minimalist
        }

        h['Accept'] = '*/*';
        h['Accept-Language'] = 'en-US,en;q=0.9,ru;q=0.8';
        h['Connection'] = 'keep-alive';
        h['Accept-Encoding'] = 'identity'; // Better for video
        h['Sec-Fetch-Dest'] = 'video';
        h['Sec-Fetch-Mode'] = 'no-cors';
        h['Sec-Fetch-Site'] = 'cross-site';

        if (referer === true) {
           if (defaultReferer) h['Referer'] = defaultReferer;
        } else if (typeof referer === 'string') {
           h['Referer'] = referer;
        }

        if (h['Referer'] && (h['Referer'].includes('instagram.com') || h['Referer'].includes('cdninstagram.com') || h['Referer'].includes('fbcdn.net'))) {
          h['Origin'] = 'https://www.instagram.com';
        }

        if (withRange && req.headers.range) {
          h['Range'] = req.headers.range;
        }

        return h;
      };

      const isInvalidResponse = (res: Response | undefined | null) => {
        if (!res) return true;
        if (!res.ok) return true;
        const contentType = res.headers.get('content-type');
        const contentLength = res.headers.get('content-length');
        
        // 400 is always invalid
        if (res.status === 400) return true;

        if (contentType && !contentType.includes('video/') && !contentType.includes('application/octet-stream')) {
          if (contentType.includes('text/html')) return true;
          if (contentType.includes('application/json')) return true;
          if (contentType.includes('text/xml')) return true;
          if (contentType.includes('text/plain') && contentLength && parseInt(contentLength) < 100) return true;
        }
        
        if (contentLength && parseInt(contentLength) < 1000) {
          return true;
        }
        return false;
      };

      let fullResponseText = ""; 
      if (isSibnet && sibnetId) {
        try {
          const initUrls = [
            `https://video.sibnet.ru/video${sibnetId}`,
            `https://video.sibnet.ru/shell.php?videoid=${sibnetId}`
          ];

          for (const initUrl of initUrls) {
            const h = getHeaders(true, false, true);
            h['Referer'] = 'https://video.sibnet.ru/';
            
            const initRes = await fetchWithRetry(initUrl, { headers: h, method: 'GET' }, 8000, 1);
            if (initRes.ok) {
              const buffer = await initRes.arrayBuffer();
              const text = iconv.decode(Buffer.from(buffer), 'windows-1251');
              if (text.includes('st=') || text.includes('stor=')) {
                fullResponseText = text;
              }
            }
            
            const setCookie = initRes.headers.get('set-cookie');
            if (setCookie) {
              const newCookies = setCookie.split(/,(?=[^;]*=)/).map(c => c.split(';')[0].trim());
              const existingCache = sibnetCookieCache.get(sibnetId) || "";
              const existingCookies = existingCache ? existingCache.split(';').map(c => c.trim()) : [];
              const combined = [...new Set([...existingCookies, ...newCookies])].join('; ');
              sibnetCookieCache.set(sibnetId, combined);
            }
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (e) {
          console.warn("Sibnet session initialization failed:", e);
        }
      }

      let response: any = new Response(null, { status: 500, statusText: 'Initial Internal State' });
      // Fallback strategies for Proxy Fetch (Enhanced with Architectural Analysis)
      const strategies = [
        { name: "Direct CDN (Architectural)", isSibnet: true, urlMod: (u: string, text?: string) => {
            if (!isSibnet || !sibnetId) return u;
            // Use dvb rotation as per architectural edge delivery logic - capped to stable nodes
            const node = text?.match(/stor=(\d+)/)?.[1] || 'dvb' + (Math.floor(Math.random() * 2) + 1);
            return SibnetExtractor.getSibnetDvbUrl(sibnetId, node, text || "");
        } },
        { name: "Minimalist CDN Access", isSibnet: true, headers: { 'User-Agent': config.userAgent, 'Referer': 'https://video.sibnet.ru/', 'Accept-Encoding': 'identity' } },
        { name: "Standard Browser", headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': '*/*', 'Referer': defaultReferer || (isSibnet ? 'https://video.sibnet.ru/' : '') } }
      ];

      for (const strategy of strategies) {
        if (strategy.isSibnet && !isSibnet) continue;
        
        console.log(`Executing Proxy Strategy: ${strategy.name}`);
        let targetUrl = url;
        if (strategy.urlMod) targetUrl = strategy.urlMod(url, fullResponseText);

        if (isSibnet) {
          console.log(`[Sibnet Proxy] Target URL: ${targetUrl}`);
        }

        try {
          // IMPORTANT: Merge client range into ALL strategies to avoid breaking video seeking
          let strategyHeaders = strategy.headers;
          if (typeof strategyHeaders === 'function') {
            strategyHeaders = await (strategyHeaders as any)();
          }
          const baseHeaders = strategyHeaders || getHeaders(true, true, false);
          const fetchHeaders: any = { ...baseHeaders };
          if (req.headers.range) {
            fetchHeaders['Range'] = req.headers.range;
          }
          
          if (isSibnet) {
            const videoId = SibnetExtractor.extractSibnetId(targetUrl);
            if (videoId) {
                fetchHeaders['Referer'] = `https://video.sibnet.ru/shell.php?videoid=${videoId}`;
            }
          }
          
          const res = await fetchWithRetry(targetUrl, { headers: fetchHeaders }, 90000, 3);
          
          if (!isInvalidResponse(res)) {
            response = res;
            console.log(`Successfully fetched with strategy: ${strategy.name}`);
            break;
          } else {
            const status = res.status;
            let reason = "unknown";
            if (!res.ok) reason = `HTTP error ${status}`;
            else {
              const ct = res.headers.get('content-type');
              const cl = res.headers.get('content-length');
              if (ct && ct.includes('text/html')) reason = "received HTML instead of video";
              else if (ct && ct.includes('application/json')) reason = "received JSON instead of video";
              else if (cl && parseInt(cl) < 1000) reason = `response too small (${cl} bytes)`;
              else reason = "invalid content type or size";
            }
            console.warn(`Strategy ${strategy.name} failed. Reason: ${reason} (Status: ${status})`);
            console.log(`Debug Headers for ${strategy.name}:`, JSON.stringify(fetchHeaders));
            if (res.status === 400 || res.status === 403) {
              try {
                const body = await res.text();
                if (body) console.log(`Error body for strategy ${strategy.name}:`, body.substring(0, 200));
              } catch(e) {}
            }
          }
        } catch (e) {
          console.warn(`Strategy ${strategy.name} threw error:`, e);
        }
      }

      // Final desperation: try external proxies specifically if still failing
      if (isInvalidResponse(response)) {
        console.log(`Structured strategies failed, trying limited external proxies...`);
        const finalProxies = [
          `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
          `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
        ];
        for (const pUrl of finalProxies) {
          try {
            const pRes = await fetchWithRetry(pUrl, { 
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } 
            }, 10000, 1);
            
            if (!isInvalidResponse(pRes)) {
              const text = await pRes.clone().text().catch(() => "");
              if (text.includes("demo") || text.includes("Usage limit") || text.includes("Bad request") || (text.length < 500 && text.includes("CORS"))) {
                  continue;
              }
              response = pRes;
              console.log(`Final success with: ${pUrl}`);
              break;
            }
          } catch (e) {}
        }
      }

      const isDrive = url.includes('drive.google.com') || url.includes('docs.google.com');
      if (isDrive) {
        let driveAttempts = 0;
        while (driveAttempts < 2 && response.ok) {
          const contentType = response.headers.get('content-type');
          if (contentType && contentType.includes('text/html')) {
            console.log(`Proxy detected Google Drive confirmation page (attempt ${driveAttempts + 1}), attempting to follow...`);
            const responseClone = response.clone();
            const html = await responseClone.text();
            const confirmMatch = html.match(/confirm=([a-zA-Z0-9_]+)/) || 
                                 html.match(/name="confirm" value="([a-zA-Z0-9_]+)"/) ||
                                 html.match(/id="confirm" value="([a-zA-Z0-9_]+)"/);
            
            if (confirmMatch && confirmMatch[1]) {
              const currentUrl = response.url || url;
              const urlObj = new URL(currentUrl);
              urlObj.searchParams.set('confirm', confirmMatch[1]);
              const finalUrl = urlObj.toString();
              
              // Use getSetCookie if available (Node 18.14.0+)
              const setCookies = (response.headers as any).getSetCookie ? (response.headers as any).getSetCookie() : [response.headers.get('set-cookie')].filter(Boolean);
              const headers: any = getHeaders();
              if (setCookies.length > 0) {
                headers['Cookie'] = setCookies.join('; ');
              }
              
              console.log(`Proxy following Drive confirmation (attempt ${driveAttempts + 1}): ${finalUrl}`);
              response = await fetch(finalUrl, { headers });
              driveAttempts++;
            } else {
              console.log("Drive returned HTML but no confirmation token found in proxy. HTML snippet:", html.substring(0, 500));
              break;
            }
          } else {
            break;
          }
        }
      }

      if (!response.ok) {
        let errorBody = "";
        try {
          const text = await response.text();
          errorBody = text.substring(0, 500);
          if (text.includes("Видео не найдено") || text.includes("Video not found") || text.includes("видео удалено")) {
            return res.status(404).json({ error: "Video not found on Sibnet source." });
          }
        } catch (e) {}
        console.error(`Proxy fetch failed for ${url}: ${response.status} ${response.statusText}. Body: ${errorBody}`);
        return res.status(response.status || 500).json({ 
          error: `Failed to fetch video from source: ${response.statusText || 'Unknown Error'}`, 
          details: errorBody,
          suggestion: isSibnet ? "Sibnet is blocking the proxy. Try clicking PLAY on the video in your browser, then copy the URL again." : undefined
        });
      }

      // Forward headers
      res.setHeader('Content-Type', response.headers.get('Content-Type') || 'video/mp4');
      const cl = response.headers.get('Content-Length');
      if (cl) res.setHeader('Content-Length', cl);
      
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      
      const contentRange = response.headers.get('Content-Range');
      if (contentRange) {
        res.setHeader('Content-Range', contentRange);
        res.status(206); // Partial Content
      } else if (req.headers.range && response.status === 200) {
        // If we requested range but got 200, we might need to handle it or just serve full
        console.log("Proxy: Requested range but got 200 status.");
      }

      if (response.body) {
        try {
          let nodeStream: any;
          
          // Check if it's ALREADY a Node.js Readable stream
          if (response.body instanceof Readable || (typeof (response.body as any).pipe === 'function' && typeof (response.body as any).on === 'function')) {
            nodeStream = response.body;
          } 
          // Check if it's a web ReadableStream (usually has 'getReader')
          else if (typeof (response.body as any).getReader === 'function') {
            nodeStream = Readable.fromWeb(response.body as any);
          }
          // Fallback
          else {
            nodeStream = response.body;
          }
          
          if (typeof nodeStream.on === 'function') {
            nodeStream.on('error', (err: any) => {
              console.error('Proxy stream error:', err);
              if (!res.headersSent) {
                res.status(500).json({ error: "Stream error during proxy", details: err instanceof Error ? err.message : String(err) });
              }
            });
          }
          
          if (typeof nodeStream.pipe === 'function') {
            nodeStream.pipe(res);
          } else {
             throw new Error("Resulting stream object does not have .pipe() method");
          }
        } catch (pipeError) {
          console.error("Pipe error in proxy:", pipeError);
          // Fallback: try to pipe it directly if the above failed but it's still a stream
          try {
            if (response.body && typeof response.body.pipe === 'function') {
               response.body.pipe(res);
            } else if (!res.headersSent) {
               res.status(500).json({ error: "Failed to stream video content: stream type mismatch" });
            }
          } catch (e) {
            if (!res.headersSent) {
               res.status(500).json({ error: "Failed to stream video content", details: String(e) });
            }
          }
        }
      } else {
        console.error("Empty response body from source:", url);
        res.status(500).json({ error: "Empty response body from video source" });
      }
    } catch (error) {
      console.error("Proxy critical error:", error);
      if (!res.headersSent) {
        const errorDetails = error instanceof Error ? error.message : String(error);
        res.status(500).json({ 
          error: "Internal server error during proxy", 
          details: errorDetails,
          suggestion: "The proxy server encountered an unexpected error. This often happens if the video source is completely unresponsive or blocking the proxy IP. Try manually downloading the video and uploading it instead."
        });
      }
    }
  });

  // Route to serve a proxied Sibnet player page for sniffing
  app.get("/api/sibnet-sniff-iframe", async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== 'string' || !url.includes('sibnet.ru')) {
      return res.status(400).send("Invalid Sibnet URL");
    }

    try {
      const idMatch = url.match(/(\d+)/);
      const videoId = idMatch ? idMatch[1] : null;
      // Prefer shell.php as it's cleaner for embedding
      const targetUrl = videoId ? `https://video.sibnet.ru/shell.php?videoid=${videoId}` : url;

      console.log(`Loading sniffer iframe for Sibnet URL: ${targetUrl}`);
      
      // Use extractSibnetFast for robust HTML retrieval even for sniffer
      const fastResult = await SibnetExtractor.extractSibnetFast(targetUrl);
      let html = "";
      if (fastResult && !fastResult.includes("http")) {
         // If it didn't return a link, it might have returned HTML if modified (unlikely now)
         // but we actually just want the HTML here.
         // Let's use fetchWithRetry since we restored it.
         html = "";
      }
      
      if (!html) {
        const headers: any = {
           'User-Agent': config.userAgent,
           'Referer': 'https://video.sibnet.ru/',
        };
        const directRes = await fetchWithRetry(targetUrl, { headers }, 10000, 1);
        html = await directRes.text();
      }

      // Inject the sniffer script
      const snifferScript = `
        <script>
          (function() {
            console.log("Sibnet Sniffer Active...");
            
            function notifyParent(url) {
              if (!url) return;
              console.log("Sniffed URL:", url);
              window.parent.postMessage({ type: 'SIBNET_SNIFFED', url: url }, '*');
            }

            // Monitor video elements
            const checkInterval = setInterval(() => {
              const video = document.querySelector('video');
              if (video && video.src && video.src.includes('.mp4')) {
                notifyParent(video.src);
              }
              
              const sources = document.querySelectorAll('source');
              sources.forEach(s => {
                if (s.src && s.src.includes('.mp4')) notifyParent(s.src);
              });

              // Check for common Sibnet player variables identified in technical analysis
              const sibnetVars = [
                'player', 'player_options', 'video_config', 'config', 'flashvars', 'vars'
              ];
              
              sibnetVars.forEach(v => {
                const val = window[v];
                if (val && typeof val === 'object') {
                  const subKeys = ['file', 'src', 'url', 'video_url', 'playable_url', 'browser_native_hd_url', 'browser_native_sd_url'];
                  subKeys.forEach(sk => {
                    if (val[sk] && typeof val[sk] === 'string' && val[sk].includes('.mp4')) {
                      notifyParent(val[sk]);
                    }
                  });
                }
              });

              // Check for og:video meta tags in the frame
              const ogVideo = document.querySelector('meta[property="og:video"]');
              if (ogVideo && ogVideo.content && ogVideo.content.includes('.mp4')) {
                notifyParent(ogVideo.content);
              }
            }, 1000);

            // Override some common player patterns
            const originalPlay = HTMLVideoElement.prototype.play;
            HTMLVideoElement.prototype.play = function() {
              if (this.src) notifyParent(this.src);
              return originalPlay.apply(this, arguments);
            };
          })();
        </script>
      `;

      // Insert script before closing body or head
      if (html.includes('</body>')) {
        html = html.replace('</body>', `${snifferScript}</body>`);
      } else if (html.includes('</head>')) {
        html = html.replace('</head>', `${snifferScript}</head>`);
      } else {
        html += snifferScript;
      }

      // Fix base URL issues for resources
      const baseUrl = `https://video.sibnet.ru/`;
      html = html.replace(/(src|href)="(\/(?!\/)[^"]+)"/g, `$1="${baseUrl}$2"`);

      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      console.error("Sniffer proxy error:", error);
      res.status(500).send(`
        <div style="background: #111; color: #ff4444; height: 100vh; display: flex; align-items: center; justify-content: center; font-family: sans-serif; text-align: center; padding: 20px;">
          <div>
            <h2 style="margin: 0 0 10px;">Sniffer Load Failed</h2>
            <p style="opacity: 0.6; font-size: 13px;">${error instanceof Error ? error.message : "Unknown error"}</p>
            <p style="margin-top: 20px; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #666;">Try clicking the sniffer button again or refreshing.</p>
          </div>
        </div>
      `);
    }
  });

  // API Health routes
  app.get("/api/health/browser", (req, res) => {
    res.json(browserManager.getHealth());
  });

  app.get("/api/health/metrics", (req, res) => {
    res.json({
      overall: metricsManager.getStats(),
      endpoints: metricsManager.getEndpointStats()
    });
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
