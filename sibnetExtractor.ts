import fetch, { Response } from "node-fetch";
import iconv from "iconv-lite";
import { GoogleGenAI, Type } from "@google/genai";
import { browserManager } from "./browserManager";
import { metricsManager } from "./metricsManager";
import { extractionCache } from "./resultCache";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const sibnetCookieCache = new Map<string, string>();

const ANDROID_UA = "Mozilla/5.0 (Linux; Android 4.4.2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/34.0.1847.114 Mobile Safari/537.36";

/**
 * AI-assisted extraction for Sibnet
 */
async function extractWithGemini(html: string): Promise<string | null> {
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) return null;

        const ai = new GoogleGenAI({ apiKey });
        const truncatedHtml = html.substring(0, 50000);

        const response = await ai.models.generateContent({
            model: "gemini-2.0-flash-exp",
            contents: `**sibnet video çıkartmak**
Bu HTML/JS içeriği içinden doğrudan oynatılabilir video bağlantısını (mp4, m3u8) tespit et.
İçerik: ${truncatedHtml}

Kurallar:
- player.src içindeki /v/hash/id.mp4 formatını bul
- .mp4 uzantılı linkleri kabul et (st= artık zorunlu değil)
- Sadece JSON döndür: {"videoUrl": "...", "confidence": 0.0-1.0}`,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        videoUrl: { type: Type.STRING },
                        confidence: { type: Type.NUMBER }
                    },
                    required: ["videoUrl"]
                }
            }
        });

        const result = JSON.parse(response.text);
        if (result.videoUrl && result.videoUrl.includes('.mp4')) {
            const absolute = result.videoUrl.startsWith('http') 
                ? result.videoUrl 
                : `https://video.sibnet.ru${result.videoUrl.startsWith('/') ? '' : '/'}${result.videoUrl}`;
            console.log(`[Sibnet-Gemini] Extracted: ${absolute.substring(0, 50)}...`);
            return absolute;
        }
    } catch (e) {
        console.warn(`[Sibnet-Gemini] Extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return null;
}

/**
 * Simple and reliable extraction - directly from player.src
 */
function analyzeSibnetContent(content: string, baseUrl: string = 'https://video.sibnet.ru'): string | null {
    // 1. player.src() - EN ÖNEMLİ VE GÜVENLİR!
    const playerSrcRegex = /player\.src\s*\(\s*\[\s*\{\s*src:\s*["']([^"']+\.mp4[^"']*)["']/i;
    const playerMatch = content.match(playerSrcRegex);
    if (playerMatch && playerMatch[1]) {
        let link = playerMatch[1].replace(/\\/g, '');
        let absolute = link.startsWith('http') ? link : baseUrl + (link.startsWith('/') ? '' : '/') + link;
        console.log(`[Sibnet] Found via player.src: ${absolute.substring(0, 50)}...`);
        return absolute;
    }

    // 2. Direct /v/hash/id.mp4 pattern (st= olmadan da çalışır)
    const vPathRegex = /["']?src["']?\s*:\s*["'](\/v\/[a-f0-9]+\/\d+\.mp4)["']/i;
    const vMatch = content.match(vPathRegex);
    if (vMatch && vMatch[1]) {
        return baseUrl + vMatch[1];
    }

    // 3. JSON player config
    const jsonRegex = /(?:vparams|playerParams|config|playerConfig|video_params)\s*[:=]\s*({[\s\S]+?})(?:\s*[,;]|\s*\n)/gi;
    let match;
    while ((match = jsonRegex.exec(content)) !== null) {
        try {
            const rawJson = match[1].replace(/'/g, '"').replace(/(\w+):/g, '"$1":');
            const data = JSON.parse(rawJson);
            const link = data.file || data.src || data.url || (data.vparams && data.vparams.src);
            if (link && typeof link === 'string' && link.includes('.mp4')) {
                let absolute = link.startsWith('http') ? link : baseUrl + (link.startsWith('/') ? '' : '/') + link;
                return absolute;
            }
        } catch (e) { }
    }

    // 4. Generic mp4/m3u8 with st= (legacy destek)
    const broadRegex = /["']? (?:file|src|url|video_src) ["']? \s* [:=] \s* ["'] ([^"']+\.(?:mp4|m3u8)[^"']*) ["']/gi;
    let broadMatch;
    while ((broadMatch = broadRegex.exec(content)) !== null) {
        let link = broadMatch[1].replace(/\\/g, '');
        let absolute = link.startsWith('http') ? link : baseUrl + (link.startsWith('/') ? '' : '/') + link;
        if (absolute.includes('.mp4') || absolute.includes('.m3u8')) {
            return absolute;
        }
    }

    return null;
}

/**
 * Extracts a numeric Sibnet ID from various URL formats
 */
export function extractSibnetId(url: string): string | null {
  if (!url) return null;
  const idMatch = url.match(/(?:video|videoid=)(\d+)/i) || url.match(/video(\d{5,8})/);
  
  if (idMatch && idMatch[1]) {
    const id = idMatch[1];
    if (id.length === 8 && id.startsWith('20')) return null;
    return id;
  }
  return null;
}

/**
 * Stage 2: HEAD request to resolve final tokenized URL
 */
async function resolveTokenizedUrl(videoId: string, path: string, signal?: AbortSignal): Promise<string | null> {
    // Try multiple video subdomains
    const subdomains = ['video', 'dv6', 'dv2', 'dv1', 'dvb1', 'dv3', 'dv4'];
    
    for (const subdomain of subdomains) {
        const url = `https://${subdomain}.sibnet.ru${path}`;
        try {
            const res = await fetch(url, {
                method: 'HEAD',
                headers: {
                    'User-Agent': ANDROID_UA,
                    'Referer': `https://video.sibnet.ru/shell.php?videoid=${videoId}`
                },
                signal,
                redirect: 'manual'
            });
            
            const location = res.headers.get('location');
            if (location) {
                let finalUrl = location.startsWith('//') ? `https:${location}` : location;
                console.log(`[Sibnet-Fast] Token resolved via ${subdomain}.sibnet.ru`);
                return finalUrl;
            }
            
            // Some videos work without redirect
            if (res.ok) {
                return url;
            }
        } catch (e) {
            continue;
        }
    }
    
    return null;
}

/**
 * FAST STATIC EXTRACTION - Two stage process (More reliable)
 */
export async function extractSibnetFast(url: string, signal?: AbortSignal): Promise<string | null> {
  const videoId = extractSibnetId(url);
  if (!videoId) return null;

  console.log(`[Sibnet-Fast] Extracting video ID: ${videoId}`);

  // Try multiple subdomains for shell.php
  const shellUrls = [
      `https://video.sibnet.ru/shell.php?videoid=${videoId}`,
      `https://dv6.sibnet.ru/shell.php?videoid=${videoId}`,
      `https://dv2.sibnet.ru/shell.php?videoid=${videoId}`,
      `https://m.video.sibnet.ru/shell.php?videoid=${videoId}`
  ];

  let path: string | null = null;

  // Try each shell URL
  for (const shellUrl of shellUrls) {
      try {
          const res = await fetch(shellUrl, {
              headers: {
                  'User-Agent': ANDROID_UA,
                  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
              },
              signal
          });
          
          if (res.ok) {
              const buffer = await res.arrayBuffer();
              const html = iconv.decode(Buffer.from(buffer), 'windows-1251');
              
              // Match player.src
              const match = html.match(/player\.src\s*\(\s*\[\s*\{\s*src:\s*["']([^"']+\.mp4[^"']*)["']/i);
              if (match && match[1]) {
                  path = match[1];
                  console.log(`[Sibnet-Fast] Found path via ${shellUrl.substring(0, 30)}...`);
                  break;
              }
          }
      } catch (e) {
          console.log(`[Sibnet-Fast] Failed: ${shellUrl.substring(0, 30)}...`);
          continue;
      }
  }

  if (!path) {
      console.log(`[Sibnet-Fast] Could not extract path from any shell URL`);
      return null;
  }

  console.log(`[Sibnet-Fast] Initial path: ${path}`);

  // Stage 2: Get tokenized URL via HEAD redirect
  const finalUrl = await resolveTokenizedUrl(videoId, path, signal);
  if (finalUrl) {
      console.log(`[Sibnet-Fast] Final URL: ${finalUrl.substring(0, 60)}...`);
  }
  
  return finalUrl;
}

/**
 * PLAYWRIGHT EXTRACTION - Fallback for complex cases
 */
export async function extractSibnetPlaywright(url: string, signal?: AbortSignal): Promise<string | null> {
  console.log("[Sibnet-Playwright] Launching browser extraction...");

  return await browserManager.withPage(async (page, context) => {
    let discoveredUrl: string | null = null;
    const startTime = Date.now();

    page.on('response', async (response) => {
      const u = response.url();
      if ((u.includes('.mp4') || u.includes('.m3u8')) && !u.includes('blob:')) {
          if (!discoveredUrl || (!discoveredUrl.includes('st=') && u.includes('st='))) {
              if (u.includes('st=')) {
                  discoveredUrl = u;
                  console.log(`[Sibnet] Network Intercept: ${u.substring(0, 60)}...`);
              }
          }
      }
    });

    const videoId = extractSibnetId(url);
    if (!videoId) return null;

    try {
      await context.clearCookies();
      await page.goto('https://video.sibnet.ru/', { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
      await delay(1000);

      await page.goto(`https://video.sibnet.ru/shell.php?videoid=${videoId}`, {
          waitUntil: 'networkidle',
          timeout: 20000
      }).catch(() => null);

      await delay(3000);

      // Extract from player.src
      discoveredUrl = await page.evaluate(() => {
          const scripts = document.querySelectorAll('script');
          for (const s of scripts) {
              const match = s.textContent.match(/player\.src\s*\(\s*\[\s*\{\s*src:\s*["']([^"']+\.mp4[^"']*)["']/i);
              if (match) return 'https://video.sibnet.ru' + match[1];
          }
          return null;
      });

      if (discoveredUrl) {
          console.log(`[Sibnet-Playwright] Found: ${discoveredUrl.substring(0, 50)}...`);
      }
    } catch (e) {
      console.warn("[Sibnet-Playwright] Error:", e);
    }

    // Try Gemini as last resort
    if (!discoveredUrl) {
        const html = await page.content().catch(() => "");
        discoveredUrl = analyzeSibnetContent(html);
        if (!discoveredUrl && html.length > 2000) {
            discoveredUrl = await extractWithGemini(html);
        }
    }

    if (discoveredUrl) {
        metricsManager.record("playwright-intercept", true, Date.now() - startTime, undefined, url);
    } else {
        metricsManager.record("playwright-intercept", false, Date.now() - startTime, "no-media-found", url);
    }

    return discoveredUrl;
  }, { timeout: 25000 });
}

/**
 * UNIFIED ENTRY POINT
 */
export async function extractSibnet(url: string, signal?: AbortSignal): Promise<{videoUrl: string, metadata?: any} | null> {
  const videoId = extractSibnetId(url);
  if (videoId) {
    const cached = extractionCache.get(videoId);
    if (cached) {
      console.log(`[Sibnet] Cache hit for ${videoId}`);
      return cached;
    }
  }

  const startTime = Date.now();
  const GLOBAL_BUDGET_MS = 15000; // 15 seconds instead of 90
  const isExpired = () => (Date.now() - startTime > GLOBAL_BUDGET_MS) || (signal && signal.aborted);

  // 1. Try fast static extraction once (no multiple retries on server)
  if (!isExpired()) {
      console.log(`[Sibnet] Static extraction attempt 1/1`);
      const fastLink = await extractSibnetFast(url, signal);
      if (fastLink) {
          console.log("[Sibnet] Static extraction successful!");
          const result = { videoUrl: fastLink };
          if (videoId) extractionCache.set(videoId, result);
          return result;
      }
  }

  // 2. Fallback to Playwright only if static completely failed
  if (isExpired()) {
      console.log("[Sibnet] Timeout before Playwright");
      return null;
  }
  
  console.log("[Sibnet] Static extraction failed, trying Playwright...");
  try {
      const plLink = await extractSibnetPlaywright(url, signal);
      if (plLink) {
          const result = { videoUrl: plLink };
          if (videoId) extractionCache.set(videoId, result);
          return result;
      }
  } catch (e) {
      console.warn("[Sibnet] Playwright extraction failed:", e);
  }

  console.error(`[Sibnet] All extraction strategies failed for ${url}`);
  return null;
}
