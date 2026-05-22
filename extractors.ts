import fetch from "node-fetch";
import { browserManager } from "./browserManager";
import { BrowserContext, Page } from "playwright";

// Helper for random delays to mimic human behavior
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Random IP generator for headers
const getRandomIP = () => Array.from({length: 4}, () => Math.floor(Math.random() * 256)).join('.');

const fetchWithTimeout = async (url: string, options: any = {}, timeout = 15000) => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  
  if (options.headers && !options.headers['X-Forwarded-For']) {
    const ip = getRandomIP();
    options.headers['X-Forwarded-For'] = ip;
    options.headers['X-Real-IP'] = ip;
  }

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
};

/**
 * Advanced Instagram Extractor
 */
export async function extractInstagram(url: string, signal: AbortSignal): Promise<string | null> {
  console.log("Starting Advanced Instagram Extraction...");
  
  return await browserManager.withPage(async (page, context) => {
    let videoUrl: string | null = null;
    
    // Intercept network requests to catch direct video URLs
    page.on('response', (response: any) => {
      const u = response.url();
      const headers = response.headers();
      const contentType = headers['content-type'] || '';
      const cl = headers['content-length'];
      
      // Look for mp4 streams that aren't DASH fragments
      if ((contentType.includes('video/') || u.includes('.mp4')) && !u.includes('bytestart')) {
        if (cl && parseInt(cl) > 1000000) { // Prefer files > 1MB
            videoUrl = u;
        } else if (!videoUrl) {
            videoUrl = u;
        }
      }
    });

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.evaluate(() => window.scrollTo(0, 500));
      await delay(2000);
    } catch (e) {
      console.warn("Instagram page load timed out, checking captured urls...");
    }

    if (videoUrl) return videoUrl;

    // Fallback: Check metadata
    return await page.evaluate(() => {
      const og = document.querySelector('meta[property="og:video"]');
      if (og) return (og as any).content;
      const video = document.querySelector('video');
      return video ? video.src : null;
    }).catch(() => null);
  }, {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
  });
}


/**
 * Advanced Facebook Extractor
 */
export async function extractFacebook(url: string, signal: AbortSignal): Promise<string | null> {
  console.log("Starting Advanced Facebook Extraction...");
  try {
    // Try specialized pattern matching first (Fast)
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36' },
      signal
    });
    const html = await res.text();
    
    const patterns = [
      /\"browser_native_sd_url\":\"([^\"]+)\"/,
      /\"browser_native_hd_url\":\"([^\"]+)\"/,
      /\"sd_src\":\"([^\"]+)\"/,
      /\"hd_src\":\"([^\"]+)\"/,
      /property=\"og:video\" content=\"([^\"]+)\"/
    ];

    for (const p of patterns) {
      const match = html.match(p);
      if (match && match[1]) {
        return match[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
      }
    }
  } catch (e) {
    console.warn("FB Fast Extraction failed, no fallback ready yet.");
  }
  return null;
}

/**
 * Cobalt Multi-Mirror Fallback
 */
export async function extractViaCobalt(url: string, signal: AbortSignal): Promise<string | null> {
  const mirrors = [
    "cobalt.bcit.cc", "royal.cobalt.tools", "cobalt.vve.pw", "cobalt.0x5.dev", "cobalt.sh"
  ].sort(() => Math.random() - 0.5);

  for (const domain of mirrors) {
    try {
      // v10 style API (preferred)
      const res = await fetchWithTimeout(`https://${domain}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ url, videoQuality: "720" }),
        signal
      }, 10000);

      if (res.ok) {
        const data = await res.json();
        const found = data.url || (data.picker?.[0]?.url) || (data.status === 'stream' && data.url);
        if (found) return found;
      }
      
      // Try v7 style fallback
      const resV7 = await fetchWithTimeout(`https://${domain}/api/json`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, videoQuality: "720" }),
        signal
      }, 8000);
      
      if (resV7.ok) {
        const data = await resV7.json();
        if (data.url) return data.url;
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}
