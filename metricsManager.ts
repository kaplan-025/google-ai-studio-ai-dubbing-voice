export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
  EXTRACT = 'extract'
}

interface MetricEntry {
  timestamp: number;
  type: string;
  success: boolean;
  duration: number;
  errorCategory?: string;
  endpoint?: string;
}

class MetricsManager {
  private history: MetricEntry[] = [];
  private readonly MAX_HISTORY = 1000;

  record(type: string, success: boolean, duration: number, errorCategory?: string, endpoint?: string) {
    this.history.push({
      timestamp: Date.now(),
      type,
      success,
      duration,
      errorCategory,
      endpoint
    });

    if (this.history.length > this.MAX_HISTORY) {
      this.history.shift();
    }

    console.log(`[Metrics] ${type} | Success: ${success} | Duration: ${duration}ms${errorCategory ? ` | Error: ${errorCategory}` : ''}${endpoint ? ` | Endpoint: ${endpoint}` : ''}`);
  }

  getStats() {
    const now = Date.now();
    const lastHour = this.history.filter(m => now - m.timestamp < 3600000);
    const memory = process.memoryUsage();
    
    if (lastHour.length === 0) return { 
      total: 0, 
      successRate: 0, 
      avgDuration: 0, 
      errorBreakdown: {},
      memory: {
        rss: Math.round(memory.rss / 1024 / 1024) + 'MB',
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + 'MB'
      }
    };

    const successCount = lastHour.filter(m => m.success).length;
    const errorBreakdown: Record<string, number> = {};

    lastHour.forEach(m => {
      if (!m.success && m.errorCategory) {
        errorBreakdown[m.errorCategory] = (errorBreakdown[m.errorCategory] || 0) + 1;
      }
    });

    return {
      total: lastHour.length,
      successRate: (successCount / lastHour.length) * 100,
      avgDuration: lastHour.reduce((acc, m) => acc + m.duration, 0) / lastHour.length,
      errorBreakdown,
      memory: {
        rss: Math.round(memory.rss / 1024 / 1024) + 'MB',
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + 'MB'
      }
    };
  }

  getEndpointStats() {
    const endpoints: Record<string, { total: number, success: number, avgDuration: number }> = {};
    
    this.history.forEach(m => {
      if (!m.endpoint) return;
      if (!endpoints[m.endpoint]) {
        endpoints[m.endpoint] = { total: 0, success: 0, avgDuration: 0 };
      }
      const entry = endpoints[m.endpoint];
      entry.total++;
      if (m.success) entry.success++;
      entry.avgDuration = (entry.avgDuration * (entry.total - 1) + m.duration) / entry.total;
    });

    return endpoints;
  }
}

export const metricsManager = new MetricsManager();
