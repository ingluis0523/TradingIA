/**
 * fetch-historical.ts
 * Downloads 6 months of Binance Futures klines (public endpoint, no auth).
 * Usage: npm run fetch-historical
 * Output: data/{SYMBOL}_{interval}.json
 */

import fs from 'fs'
import path from 'path'

const BASE = 'https://fapi.binance.com/fapi/v1/klines'
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'SOLUSDT'] as const
const INTERVALS = ['1h', '4h'] as const
const MONTHS = 6
const LIMIT = 1500   // max per Binance request (weight = 10 for limit > 500)
const DELAY_MS = 350 // stay well under 2400 weight/min rate limit

const DATA_DIR = path.join(process.cwd(), 'data')

// Candle duration in ms per interval
const INTERVAL_MS: Record<string, number> = {
  '1h':  3_600_000,
  '4h': 14_400_000,
}

interface Kline {
  openTime:  number
  open:      number
  high:      number
  low:       number
  close:     number
  volume:    number
  closeTime: number
}

async function fetchBatch(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number,
): Promise<Kline[]> {
  const url = `${BASE}?symbol=${symbol}&interval=${interval}` +
              `&startTime=${startTime}&endTime=${endTime}&limit=${LIMIT}`
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`HTTP ${res.status} fetching ${symbol} ${interval}: ${body}`)
  }
  const raw = (await res.json()) as unknown[][]
  return raw.map(r => ({
    openTime:  Number(r[0]),
    open:      parseFloat(r[1] as string),
    high:      parseFloat(r[2] as string),
    low:       parseFloat(r[3] as string),
    close:     parseFloat(r[4] as string),
    volume:    parseFloat(r[5] as string),
    closeTime: Number(r[6]),
  }))
}

async function fetchAll(symbol: string, interval: string): Promise<Kline[]> {
  const endTime = Date.now()
  const startTime = endTime - MONTHS * 30 * 24 * 3_600_000
  const batchMs = LIMIT * INTERVAL_MS[interval]

  const all: Kline[] = []
  let cursor = startTime

  while (cursor < endTime) {
    const batchEnd = Math.min(cursor + batchMs - 1, endTime)
    const batch = await fetchBatch(symbol, interval, cursor, batchEnd)
    if (batch.length === 0) break
    all.push(...batch)
    cursor = batch[batch.length - 1].closeTime + 1
    process.stdout.write('.')
    if (cursor < endTime) await sleep(DELAY_MS)
  }

  // Deduplicate by openTime (shouldn't happen but safe)
  const seen = new Set<number>()
  return all.filter(k => {
    if (seen.has(k.openTime)) return false
    seen.add(k.openTime)
    return true
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  console.log(`Downloading ${MONTHS} months of klines → ${DATA_DIR}\n`)

  for (const symbol of SYMBOLS) {
    for (const interval of INTERVALS) {
      process.stdout.write(`  ${symbol} ${interval} `)
      try {
        const candles = await fetchAll(symbol, interval)
        const file = path.join(DATA_DIR, `${symbol}_${interval}.json`)
        fs.writeFileSync(file, JSON.stringify(candles))
        console.log(` ✓ ${candles.length} candles`)
      } catch (err) {
        console.error(`\n  ERROR: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  console.log('\nDone. Run "npm run backtest" to start the simulation.')
}

main().catch(err => { console.error(err); process.exit(1) })
