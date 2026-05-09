# TradingIA — Guía de Configuración

## Arquitectura

```
Vercel (Next.js 14)
  ├── Dashboard React con actualizaciones en tiempo real
  ├── API Routes (bot control, precios, trades)
  └── Cron Job (cada minuto → ejecuta el motor de trading)

Supabase (PostgreSQL + Realtime)
  ├── bot_config — configuración del bot
  ├── trades — historial de operaciones
  ├── signals — señales generadas
  └── bot_logs — logs del bot

Binance Futures Testnet
  └── BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT
```

## Paso 1: Instalar dependencias

```bash
npm install
```

## Paso 2: Configurar Binance Testnet

1. Ve a https://testnet.binancefuture.com
2. Regístrate con tu cuenta de GitHub
3. Genera API Key y Secret
4. Solicita fondos de prueba (testnet faucet)

## Paso 3: Configurar Supabase

1. Ve a https://app.supabase.com y crea un proyecto
2. En el SQL Editor, ejecuta el contenido de `supabase/schema.sql`
3. Copia la URL del proyecto y las keys (Settings → API)

## Paso 4: Variables de Entorno

Copia `.env.example` a `.env.local` y rellena:

```bash
cp .env.example .env.local
```

```env
BINANCE_API_KEY=tu_api_key_del_testnet
BINANCE_API_SECRET=tu_api_secret_del_testnet
BINANCE_BASE_URL=https://testnet.binancefuture.com

NEXT_PUBLIC_SUPABASE_URL=https://tu-proyecto.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=tu_anon_key
SUPABASE_SERVICE_ROLE_KEY=tu_service_role_key

BOT_INITIAL_CAPITAL=1000
BOT_MAX_POSITIONS=3
BOT_RISK_PER_TRADE=0.02
BOT_DEFAULT_LEVERAGE=3
BOT_MAX_DAILY_LOSS=0.05

CRON_SECRET=genera_un_string_aleatorio_aqui
TRADING_MODE=testnet
```

## Paso 5: Desarrollo local

```bash
npm run dev
```

Abre http://localhost:3000

## Paso 6: Despliegue en Vercel

1. Instala Vercel CLI: `npm i -g vercel`
2. Ejecuta: `vercel`
3. Configura las variables de entorno en el dashboard de Vercel
4. El cron job se ejecutará automáticamente cada minuto (requiere Vercel Pro)
5. Para el plan gratuito: usa el botón "Tick Manual" en el dashboard

## Estrategia de Trading (AMSS)

### Parámetros por defecto
- **Timeframe principal**: 1H
- **Filtro de tendencia**: 4H
- **Leverage**: 3x (ajustable 1x-10x)
- **Riesgo por trade**: 2% del capital
- **Stop Loss**: 1.5x ATR(14)
- **Take Profit 1**: 2.5x ATR (50% de la posición)
- **Take Profit 2**: 4.0x ATR (50% restante)

### Señales de entrada LONG
1. 4H: EMA20 > EMA50 Y precio > EMA200
2. 1H: Histograma MACD cruza de negativo a positivo
3. 1H: RSI entre 35 y 68
4. 1H: SuperTrend en dirección UP
5. Volumen actual > 110% del Volume MA(20)
6. ADX > 20 (tendencia confirmada)

### Señales de entrada SHORT
Condiciones inversas con filtro 4H bajista.

### Gestión dinámica
- Trailing stop activo tras TP1
- Cierre anticipado si SuperTrend revierte
- Parada automática al alcanzar límite de pérdida diaria (5%)

## Rendimiento Objetivo

| Métrica | Objetivo |
|---------|----------|
| Rendimiento semanal | ≥ 5% |
| Win Rate | ≥ 55% |
| Risk/Reward | ≥ 1:1.5 |
| Max Drawdown | ≤ 15% |
| Profit Factor | ≥ 1.3 |

## Nota sobre el Cron Job

- **Vercel Free**: El cron mínimo es 1 vez/hora. Usa el botón "Tick Manual" o configura un cron externo (cron-job.org) que llame a `/api/cron/trade` con el header `Authorization: Bearer TU_CRON_SECRET`
- **Vercel Pro**: El cron se ejecuta cada minuto automáticamente

## Monitoreo

El dashboard muestra en tiempo real:
- Precios de BTC, ETH, SOL, BNB, XRP
- Posiciones abiertas con P&L no realizado
- Gráfico de velas con EMA 20/50
- Curva de capital acumulada
- Log de actividad del bot
- Métricas de rendimiento (Win Rate, Sharpe, Drawdown)
