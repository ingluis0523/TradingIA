export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY
  const cronSecret = process.env.CRON_SECRET

  const envStatus = {
    NEXT_PUBLIC_SUPABASE_URL: url ? `✅ presente (${url.slice(0, 30)}...)` : '❌ FALTA',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: anon ? `✅ presente (${anon.slice(0, 20)}...)` : '❌ FALTA',
    SUPABASE_SERVICE_ROLE_KEY: service ? `✅ presente (${service.slice(0, 20)}...)` : '❌ FALTA — usando anon key',
    CRON_SECRET: cronSecret ? `✅ presente` : '❌ FALTA — endpoint sin protección',
  }

  if (!url || !anon) {
    return NextResponse.json({ ok: false, envStatus, error: 'Variables de Supabase no configuradas' })
  }

  const key = service || anon
  const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  // Test 1: read bot_config
  const { data: configData, error: configError } = await client
    .from('bot_config')
    .select('id, is_running')
    .limit(1)

  // Test 2: write a test log
  const testMessage = `🔧 Debug test — ${new Date().toISOString()}`
  const { error: writeError } = await client
    .from('bot_logs')
    .insert({ level: 'INFO', message: testMessage, timestamp: new Date().toISOString() })

  // Test 3: read back to confirm
  const { data: readBack, error: readError } = await client
    .from('bot_logs')
    .select('id, message, timestamp')
    .eq('message', testMessage)
    .limit(1)

  return NextResponse.json({
    ok: !configError && !writeError,
    envStatus,
    usingServiceKey: !!service,
    tests: {
      readConfig: configError ? `❌ ${configError.message}` : `✅ config encontrada: is_running=${configData?.[0]?.is_running}`,
      writeLog: writeError ? `❌ ${writeError.message}` : '✅ log escrito correctamente',
      readBack: readError ? `❌ ${readError.message}` : readBack?.length ? `✅ log confirmado en BD` : '⚠️ log no encontrado al releer',
    },
  })
}
