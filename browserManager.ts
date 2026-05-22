import { chromium, Browser, BrowserContext, Page } from "playwright";

/**
 * PRODUCTION-GRADE BROWSER MANAGER (V2)
 * Features: Atomic restarts, Crash recovery, Memory-safe flags, and Singleton orchestration.
 */
class BrowserManager {
  private browser: Browser | null = null;
  private launchPromise: Promise<Browser> | null = null;
  private activePages = 0;
  private readonly MAX_CONCURRENT_PAGES = 3; 
  private readonly MAX_QUEUE_SIZE = 10;
  private queue: (() => void)[] = [];

  public getHealth() {
    return {
      activePages: this.activePages,
      queueDepth: this.queue.length,
      browserConnected: this.browser?.isConnected() || false,
      concurrencyLimit: this.MAX_CONCURRENT_PAGES
    };
  }

  private readonly launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-blink-features=AutomationControlled',
    '--disable-service-workers',
    '--disable-web-security',
    '--window-size=1280,720'
  ];

  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    if (this.launchPromise) {
      return this.launchPromise;
    }

    this.launchPromise = (async () => {
      try {
        console.log("[BrowserManager] Launching stabilized Chromium instance...");
        const newBrowser = await chromium.launch({
          headless: true,
          args: this.launchArgs
        });

        newBrowser.on('disconnected', () => {
          console.error("[BrowserManager] CRITICAL: Browser disconnected/crashed.");
          this.browser = null;
          this.launchPromise = null;
        });

        this.browser = newBrowser;
        return newBrowser;
      } catch (error) {
        this.launchPromise = null;
        console.error("[BrowserManager] Failed to start browser:", error);
        throw error;
      }
    })();

    return this.launchPromise;
  }

  /**
   * SEMAPHORE WITH BACKPRESSURE
   */
  private async acquireSlot(): Promise<void> {
    if (this.activePages < this.MAX_CONCURRENT_PAGES) {
      this.activePages++;
      return;
    }

    if (this.queue.length >= this.MAX_QUEUE_SIZE) {
      throw new Error("Server capacity reached (Browser Queue Full). Please try again in a moment.");
    }

    return new Promise(resolve => this.queue.push(resolve));
  }

  private releaseSlot(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.activePages = Math.max(0, this.activePages - 1);
    }
  }

  /**
   * RESOURCE DISPOSAL WRAPPER (The "withPage" pattern)
   * Guaranteed to clean up even if the extraction logic crashes or the browser dies.
   */
  async withPage<T>(
    fn: (page: Page, context: BrowserContext) => Promise<T>,
    options: { userAgent?: string; timeout?: number } = {}
  ): Promise<T | null> {
    await this.acquireSlot();

    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      const browser = await this.getBrowser();
      context = await browser.newContext({
        userAgent: options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 },
      });
      context.setDefaultNavigationTimeout(options.timeout || 15000);
      context.setDefaultTimeout(options.timeout || 15000);

      // Stealth & Fingerprint Protection
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        (navigator as any).chrome = { runtime: {} };
      });

      page = await context.newPage();
      page.setDefaultTimeout(options.timeout || 15000);

      return await fn(page, context);
    } catch (error) {
      if (error instanceof Error && (error.message.includes('closed') || error.message.includes('disconnected'))) {
        console.error("[BrowserManager] Detected browser crash. Invalidating singleton.");
        this.browser = null;
        this.launchPromise = null;
      }
      console.error("[BrowserManager] Execution error:", error);
      return null;
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      this.releaseSlot();
    }
  }

  async shutdown(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.launchPromise = null;
    }
  }
}

export const browserManager = new BrowserManager();

// Ensure cleanup
const cleanup = () => browserManager.shutdown();
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
