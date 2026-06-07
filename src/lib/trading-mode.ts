export type TradingMode = 'testnet' | 'mainnet'

export interface ModeFlags {
  tradingMode: TradingMode
  shadowMode: boolean
}

export function getCurrentMode(): ModeFlags {
  const tradingMode = (process.env.TRADING_MODE || 'testnet') as TradingMode
  const shadowMode = process.env.SHADOW_MODE === 'true'

  if (!['testnet', 'mainnet'].includes(tradingMode)) {
    throw new Error(`TRADING_MODE inválido: ${tradingMode}. Debe ser 'testnet' o 'mainnet'.`)
  }

  return { tradingMode, shadowMode }
}

export function getBinanceBaseUrl(mode: TradingMode): string {
  return mode === 'mainnet'
    ? 'https://fapi.binance.com'
    : 'https://testnet.binancefuture.com'
}
