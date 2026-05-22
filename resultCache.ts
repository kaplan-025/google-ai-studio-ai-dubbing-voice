interface CacheEntry<T> {
  value: T;
  expiry: number;
}

class ResultCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly DEFAULT_TTL = 3600000; // 1 hour

  set(key: string, value: T, ttl: number = this.DEFAULT_TTL) {
    this.cache.set(key, {
      value,
      expiry: Date.now() + ttl
    });
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  delete(key: string) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }
}

export const extractionCache = new ResultCache<{ videoUrl: string, metadata?: any }>();
