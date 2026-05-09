import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(value: number, decimals = 2): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value)
}

export function formatPercent(value: number, decimals = 2): string {
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(decimals)}%`
}

export function formatPrice(price: number, symbol: string): string {
  if (symbol.startsWith('BTC')) return price.toFixed(1)
  if (symbol.startsWith('ETH')) return price.toFixed(2)
  if (symbol.startsWith('XRP')) return price.toFixed(4)
  return price.toFixed(3)
}

export function formatNumber(value: number, decimals = 4): string {
  return value.toFixed(decimals)
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

export function formatTimestamp(ts: number | string): string {
  return new Date(ts).toLocaleString('es-ES', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

export function timeAgo(ts: number | string): string {
  const diff = Date.now() - new Date(ts).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `hace ${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `hace ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `hace ${hours}h`
  return `hace ${Math.floor(hours / 24)}d`
}

export function getPnlClass(pnl: number): string {
  if (pnl > 0) return 'text-green-400'
  if (pnl < 0) return 'text-red-400'
  return 'text-gray-400'
}

export function getPnlBgClass(pnl: number): string {
  if (pnl > 0) return 'bg-green-500/10 border-green-500/20'
  if (pnl < 0) return 'bg-red-500/10 border-red-500/20'
  return 'bg-gray-500/10 border-gray-500/20'
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step
}

export function calculatePnl(side: 'BUY' | 'SELL', entryPrice: number, exitPrice: number, quantity: number, leverage: number): number {
  const priceDiff = side === 'BUY' ? exitPrice - entryPrice : entryPrice - exitPrice
  return priceDiff * quantity * leverage
}

export function calculatePnlPct(side: 'BUY' | 'SELL', entryPrice: number, exitPrice: number, leverage: number): number {
  const pricePct = side === 'BUY'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100
  return pricePct * leverage
}
