import { NextResponse } from 'next/server'
import { getCurrentMode } from '@/lib/trading-mode'

export async function GET() {
  return NextResponse.json(getCurrentMode())
}
