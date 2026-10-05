// ============================================================================
// OmniFlow — service wiring.
// Exports the singletons the app uses, with fxService injected into
// marketData (which is constructed in marketData.ts without a real fx).
// ============================================================================

export {
  CurrencyExchangeService,
  fxService,
  convert,
  retargetToBase,
  type RatesForBase,
} from './fx';

export {
  MarketDataService,
  type QuoteResult,
  type QuoteSource,
} from './marketData';

export {
  extractFromOcrText,
  ocrImage,
  parseReceipt,
  type ParsedReceipt,
} from './ocr';

// Re-export a properly-wired marketData instance. The module-level one in
// marketData.ts has an undefined fx; here we expose the wired version.
import { MarketDataService } from './marketData';
import { fxService } from './fx';

/** The canonical market data service used across the app (wired to fx). */
export const marketDataService = new MarketDataService(fxService);
