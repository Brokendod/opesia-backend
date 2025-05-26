// src/server.ts
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';

// ===== TYPES =====
interface FundingRate {
  exchange: string;
  symbol: string;
  rate: number;
  nextFundingTime: Date;
  timestamp: Date;
}

interface ArbitrageOpportunity {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  longRate: number;
  shortRate: number;
  spread: number;
  profitPotential: number;
  timestamp: Date;
}

interface ExchangeConfig {
  name: string;
  apiUrl: string;
  wsUrl?: string;
  rateLimits: {
    requests: number;
    window: number;
  };
}

// ===== CONFIGURATION DES EXCHANGES =====
const EXCHANGES_CONFIG: Record<string, ExchangeConfig> = {
  binance: {
    name: 'Binance',
    apiUrl: 'https://fapi.binance.com',
    wsUrl: 'wss://fstream.binance.com',
    rateLimits: { requests: 1200, window: 60000 }
  },
  bybit: {
    name: 'Bybit',
    apiUrl: 'https://api.bybit.com',
    wsUrl: 'wss://stream.bybit.com',
    rateLimits: { requests: 600, window: 60000 }
  },
  okx: {
    name: 'OKX',
    apiUrl: 'https://www.okx.com',
    wsUrl: 'wss://ws.okx.com:8443',
    rateLimits: { requests: 300, window: 60000 }
  }
};

// ===== COLLECTEUR DE BASE =====
abstract class BaseCollector {
  protected exchangeName: string;
  protected config: ExchangeConfig;
  protected lastRequestTime: number = 0;

  constructor(exchangeName: string) {
    this.exchangeName = exchangeName;
    this.config = EXCHANGES_CONFIG[exchangeName];
  }

  abstract collectFundingRates(): Promise<FundingRate[]>;

  protected async rateLimitedRequest(url: string): Promise<any> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    const minInterval = this.config.rateLimits.window / this.config.rateLimits.requests;

    if (timeSinceLastRequest < minInterval) {
      await this.sleep(minInterval - timeSinceLastRequest);
    }

    this.lastRequestTime = Date.now();
    
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      console.error(`[${this.exchangeName}] Request failed:`, error);
      throw error;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ===== COLLECTEUR BINANCE =====
class BinanceCollector extends BaseCollector {
  constructor() {
    super('binance');
  }

  async collectFundingRates(): Promise<FundingRate[]> {
    try {
      console.log('🔄 [Binance] Collecting funding rates...');
      const data = await this.rateLimitedRequest(
        `${this.config.apiUrl}/fapi/v1/premiumIndex`
      );

      const rates = data
        .filter((item: any) => item.symbol && item.lastFundingRate)
        .map((item: any) => ({
          exchange: 'binance',
          symbol: item.symbol,
          rate: parseFloat(item.lastFundingRate) * 100,
          nextFundingTime: new Date(item.nextFundingTime),
          timestamp: new Date()
        }));

      console.log(`✅ [Binance] Collected ${rates.length} rates`);
      return rates;
    } catch (error) {
      console.error('❌ [Binance] Collection failed:', error);
      return [];
    }
  }
}

// ===== COLLECTEUR BYBIT =====
class BybitCollector extends BaseCollector {
  constructor() {
    super('bybit');
  }

  async collectFundingRates(): Promise<FundingRate[]> {
    try {
      console.log('🔄 [Bybit] Collecting funding rates...');
      const data = await this.rateLimitedRequest(
        `${this.config.apiUrl}/v5/market/tickers?category=linear`
      );

      if (!data.result?.list) {
        console.log('⚠️ [Bybit] No data received');
        return [];
      }

      const rates = data.result.list
        .filter((item: any) => item.symbol && item.fundingRate)
        .map((item: any) => ({
          exchange: 'bybit',
          symbol: item.symbol,
          rate: parseFloat(item.fundingRate) * 100,
          nextFundingTime: new Date(parseInt(item.nextFundingTime)),
          timestamp: new Date()
        }));

      console.log(`✅ [Bybit] Collected ${rates.length} rates`);
      return rates;
    } catch (error) {
      console.error('❌ [Bybit] Collection failed:', error);
      return [];
    }
  }
}

// ===== DÉTECTEUR D'ARBITRAGE =====
class ArbitrageDetector {
  private readonly MIN_SPREAD = 0.01; // 0.01% minimum spread

  detectOpportunities(rates: FundingRate[]): ArbitrageOpportunity[] {
    console.log('🔍 Detecting arbitrage opportunities...');
    const opportunities: ArbitrageOpportunity[] = [];
    const ratesBySymbol = this.groupBySymbol(rates);

    for (const [symbol, symbolRates] of ratesBySymbol.entries()) {
      if (symbolRates.length < 2) continue;

      // Trier par taux (du plus bas au plus haut)
      symbolRates.sort((a, b) => a.rate - b.rate);

      const lowest = symbolRates[0];
      const highest = symbolRates[symbolRates.length - 1];
      const spread = highest.rate - lowest.rate;

      if (spread > this.MIN_SPREAD) {
        opportunities.push({
          symbol,
          longExchange: lowest.exchange,
          shortExchange: highest.exchange,
          longRate: lowest.rate,
          shortRate: highest.rate,
          spread,
          profitPotential: this.calculateProfitPotential(spread),
          timestamp: new Date()
        });
      }
    }

    const sortedOpportunities = opportunities.sort((a, b) => b.spread - a.spread);
    console.log(`💰 Found ${sortedOpportunities.length} arbitrage opportunities`);
    
    return sortedOpportunities;
  }

  private groupBySymbol(rates: FundingRate[]): Map<string, FundingRate[]> {
    const grouped = new Map<string, FundingRate[]>();
    
    for (const rate of rates) {
      if (!grouped.has(rate.symbol)) {
        grouped.set(rate.symbol, []);
      }
      grouped.get(rate.symbol)!.push(rate);
    }
    
    return grouped;
  }

  private calculateProfitPotential(spread: number): number {
    // Calcul annualisé (funding toutes les 8h = 3x par jour)
    return spread * 3 * 365;
  }
}

// ===== SERVICE PRINCIPAL =====
class DataService {
  private collectors = [
    new BinanceCollector(),
    new BybitCollector()
  ];
  private detector = new ArbitrageDetector();
  private latestRates: FundingRate[] = [];
  private latestOpportunities: ArbitrageOpportunity[] = [];

  async collectAllData(): Promise<void> {
    console.log('🚀 Starting data collection cycle...');
    
    try {
      // Collecter en parallèle
      const promises = this.collectors.map(collector => 
        collector.collectFundingRates().catch(error => {
          console.error(`Collector failed:`, error);
          return [];
        })
      );

      const results = await Promise.all(promises);
      this.latestRates = results.flat();
      
      // Détecter les opportunités
      this.latestOpportunities = this.detector.detectOpportunities(this.latestRates);
      
      console.log(`✨ Collection complete: ${this.latestRates.length} rates, ${this.latestOpportunities.length} opportunities`);
    } catch (error) {
      console.error('💥 Data collection failed:', error);
    }
  }

  getRates(): FundingRate[] {
    return this.latestRates;
  }

  getOpportunities(): ArbitrageOpportunity[] {
    return this.latestOpportunities;
  }

  getTopOpportunities(limit: number = 10): ArbitrageOpportunity[] {
    return this.latestOpportunities.slice(0, limit);
  }

  getRatesByExchange(exchange: string): FundingRate[] {
    return this.latestRates.filter(rate => rate.exchange === exchange);
  }

  getStats() {
    const exchanges = new Set(this.latestRates.map(r => r.exchange));
    const symbols = new Set(this.latestRates.map(r => r.symbol));
    
    return {
      totalRates: this.latestRates.length,
      totalExchanges: exchanges.size,
      totalSymbols: symbols.size,
      totalOpportunities: this.latestOpportunities.length,
      topSpread: this.latestOpportunities.length > 0 ? this.latestOpportunities[0].spread : 0,
      lastUpdate: new Date().toISOString()
    };
  }
}

// ===== SERVEUR EXPRESS =====
const app = express();
const server = createServer(app);
const io = new SocketServer(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || "*"
}));
app.use(express.json());

// Service principal
const dataService = new DataService();

// ===== ROUTES API =====

// Route de test
app.get('/', (req, res) => {
  res.json({
    message: '🚀 Opesia Arbitrage API is running!',
    version: '1.0.0',
    endpoints: [
      'GET /api/rates - Get all funding rates',
      'GET /api/opportunities - Get arbitrage opportunities',
      'GET /api/stats - Get statistics',
      'GET /api/exchanges/:exchange/rates - Get rates for specific exchange'
    ]
  });
});

// Statistiques générales
app.get('/api/stats', (req, res) => {
  res.json({
    success: true,
    data: dataService.getStats()
  });
});

// Tous les taux de financement
app.get('/api/rates', (req, res) => {
  res.json({
    success: true,
    data: dataService.getRates(),
    count: dataService.getRates().length,
    timestamp: new Date().toISOString()
  });
});

// Opportunités d'arbitrage
app.get('/api/opportunities', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const opportunities = dataService.getTopOpportunities(limit);
  
  res.json({
    success: true,
    data: opportunities,
    count: opportunities.length,
    timestamp: new Date().toISOString()
  });
});

// Taux par exchange
app.get('/api/exchanges/:exchange/rates', (req, res) => {
  const { exchange } = req.params;
  const rates = dataService.getRatesByExchange(exchange.toLowerCase());
  
  res.json({
    success: true,
    exchange,
    data: rates,
    count: rates.length,
    timestamp: new Date().toISOString()
  });
});

// ===== WEBSOCKET =====
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);
  
  // Envoyer les données actuelles immédiatement
  socket.emit('rates_update', {
    rates: dataService.getRates(),
    timestamp: new Date().toISOString()
  });
  
  socket.emit('opportunities_update', {
    opportunities: dataService.getTopOpportunities(),
    timestamp: new Date().toISOString()
  });

  socket.emit('stats_update', dataService.getStats());

  socket.on('disconnect', () => {
    console.log('🔌 Client disconnected:', socket.id);
  });
});

// ===== COLLECTE PÉRIODIQUE =====
const COLLECTION_INTERVAL = 60000; // 1 minute

async function startDataCollection() {
  console.log('🎯 Starting Opesia Arbitrage Data Collection Service...');
  
  // Première collecte au démarrage
  await dataService.collectAllData();
  
  // Diffuser les données initiales
  io.emit('rates_update', {
    rates: dataService.getRates(),
    timestamp: new Date().toISOString()
  });
  
  io.emit('opportunities_update', {
    opportunities: dataService.getTopOpportunities(),
    timestamp: new Date().toISOString()
  });

  io.emit('stats_update', dataService.getStats());
  
  // Collecte périodique
  setInterval(async () => {
    await dataService.collectAllData();
    
    // Diffuser les mises à jour via WebSocket
    io.emit('rates_update', {
      rates: dataService.getRates(),
      timestamp: new Date().toISOString()
    });
    
    io.emit('opportunities_update', {
      opportunities: dataService.getTopOpportunities(),
      timestamp: new Date().toISOString()
    });

    io.emit('stats_update', dataService.getStats());
    
  }, COLLECTION_INTERVAL);
}

// ===== DÉMARRAGE DU SERVEUR =====
const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`🌐 Opesia Arbitrage API running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🔗 API Base: http://localhost:${PORT}/api`);
  
  // Démarrer la collecte de données
  startDataCollection();
});

// Gestion propre de l'arrêt
process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

export default app;
