# TradingIA — Spec Maestro Multi-Usuario v1.0

> Documento de planificación maestro del refactor de TradingIA de single-user a multi-tenant SaaS, manteniendo costo de operación en $0 durante la etapa inicial.

---

## 1. Resumen ejecutivo

TradingIA es un bot de trading algorítmico para criptomonedas en Binance Futures que actualmente opera en modo single-user, conectado a testnet, ejecutando una estrategia AMSS (Adaptive Multi-Signal) sobre 5 pares. Tras 22 días de prueba real con 30 operaciones (+339 USDT netos, win rate 40.7%, profit factor 1.19), se identificaron bugs críticos de ejecución y se decidió evolucionar el sistema a un SaaS multi-usuario.

Este spec planifica esa evolución en **5 fases** ejecutables por Claude Code, con costo de infraestructura $0 durante la etapa inicial, soportando hasta ~50 usuarios concurrentes sin necesitar upgrade a planes pagos.

---

## 2. Objetivos del proyecto

### Objetivos primarios

1. **Estabilidad de ejecución**: eliminar los bugs críticos que causaron la operación "pegada" del testnet y que en producción real generarían pérdidas no controladas.
2. **Multi-tenancy**: soportar múltiples usuarios independientes, cada uno con sus propias API keys de Binance, su propio balance, sus propias posiciones y su propio bot encendido/apagado.
3. **Super admin**: panel exclusivo del operador (Luis) para crear usuarios, ver métricas agregadas y por usuario, y ejecutar acciones de emergencia (kill switch global, kill switch por usuario).
4. **Costo operativo $0** en la primera etapa (hasta ~15-20 usuarios reales, ~3 meses).
5. **Experiencia de usuario simple**: cada usuario configura sus API keys, define su asignación de capital, enciende el bot. El resto sucede automáticamente.

### Anti-objetivos (explícitamente fuera de scope)

- Garantizar rendimientos específicos (15-30% mensual) — esta promesa se elimina del producto.
- Custodia de fondos (los fondos viven en la cuenta Binance del usuario, el bot solo opera con API keys).
- Notificaciones por correo (se posterga; el dashboard tiene log en tiempo real).
- Soporte multi-exchange (solo Binance Futures).
- Modo spot, opciones, margin trading u otros productos de Binance.
- Estrategias customizables por usuario (todos usan la misma estrategia AMSS con parámetros default).

---

## 3. Stack tecnológico

| Capa | Tecnología | Plan | Costo |
|---|---|---|---|
| Frontend UI | Next.js 14 (App Router) en Vercel | Hobby | $0 |
| Auth | Supabase Auth (email + password) | Free | $0 |
| Base de datos | Supabase Postgres + RLS | Free | $0 |
| Cifrado de secretos | Supabase Vault | Free | $0 |
| Motor de trading | Supabase Edge Functions (Deno) | Free | $0 |
| Scheduler | Supabase pg_cron + pg_net | Free | $0 |
| Cola (futuro, fase 5+) | Supabase pgmq | Free | $0 |
| Exchange | Binance Futures API (mainnet) | — | $0 |
| Repositorio | GitHub | Free | $0 |

**Total infra: $0/mes en etapa 1.**

---

## 4. Arquitectura objetivo

```
┌────────────────────────────────────────────────────────────────┐
│                    Vercel Hobby (Next.js)                       │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐    │
│  │ /login       │  │ /dashboard   │  │ /admin             │    │
│  │ /signup*     │  │   bot on/off │  │   usuarios         │    │
│  │              │  │   posiciones │  │   métricas global  │    │
│  │              │  │   historial  │  │   kill switch      │    │
│  └──────────────┘  └──────────────┘  └────────────────────┘    │
│              * signup deshabilitado; solo admin crea usuarios   │
└────────────────┬───────────────────────────────────────────────┘
                 │ supabase-js (SSR + cliente, JWT)
                 ▼
┌────────────────────────────────────────────────────────────────┐
│                  Supabase Free Tier                             │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐      │
│  │  Auth (email+password, sin signup público)           │      │
│  └──────────────────────────────────────────────────────┘      │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐      │
│  │  Postgres + RLS                                       │      │
│  │  ── tabla users (rol: admin | trader)                │      │
│  │  ── tabla user_bot_config (per-user)                 │      │
│  │  ── tabla user_api_keys (referencia a Vault)         │      │
│  │  ── tabla trades (con user_id)                       │      │
│  │  ── tabla signals (compartidas, sin user_id)         │      │
│  │  ── tabla bot_logs (con user_id opcional)            │      │
│  │  ── tabla global_kill_switch                         │      │
│  └──────────────────────────────────────────────────────┘      │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐      │
│  │  Vault (cifrado at-rest de API keys Binance)         │      │
│  └──────────────────────────────────────────────────────┘      │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐      │
│  │  pg_cron + pg_net                                     │      │
│  │  ── job 'trading-tick' cada 5 min                    │      │
│  │  ── job 'cleanup-logs' diario                        │      │
│  │  ── job 'compute-daily-metrics' cada hora            │      │
│  └─────────┬────────────────────────────────────────────┘      │
│            │ HTTP POST                                           │
│            ▼                                                     │
│  ┌──────────────────────────────────────────────────────┐      │
│  │  Edge Function: trading-tick (Deno)                  │      │
│  │  ── Verifica global_kill_switch                      │      │
│  │  ── Fase compartida: fetch klines, calcula           │      │
│  │     indicadores y señales (5 pares × 2 timeframes)   │      │
│  │  ── Fase per-user: iterar usuarios con bot=ON,       │      │
│  │     descifrar API keys, manage posiciones, ejecutar  │      │
│  │     entradas si aplica                                │      │
│  └─────────┬────────────────────────────────────────────┘      │
└────────────┼────────────────────────────────────────────────────┘
             │ Binance API (por usuario, con sus credenciales)
             ▼
       ┌─────────────────────┐
       │  Binance Futures    │
       │  Mainnet (real)     │
       │  ISOLATED, 3x       │
       │  Native SL/TP       │
       └─────────────────────┘
```

### Principios arquitectónicos clave

1. **Single source of truth: Binance.** Si hay discrepancia entre la BD y Binance, Binance manda. El sistema reconcilia hacia Binance, no al revés.
2. **Native orders.** SL, TP1, TP2 se colocan como órdenes nativas en Binance. Si el bot cae, la posición queda protegida.
3. **Idempotencia.** Todas las órdenes usan `newClientOrderId` único derivado del intent, no del timestamp. Reenvíos por reintentos no duplican posiciones.
4. **Locking del cron.** El job marca un lock en BD antes de iniciar; si otro tick está corriendo, sale sin hacer nada. Previene ticks solapados.
5. **Aislamiento por usuario.** Errores con un usuario no afectan a otros. Loop per-user envuelto en try/catch independiente.
6. **Kill switches en cascada.** Global (todos los bots), por usuario (un bot), y por límite de pérdida diaria (auto-pausa).
7. **Free-tier-aware.** Logs auto-purgan a 7 días, signals a 30 días, índices de DB diseñados para mantenerse <500MB.

---

## 5. Decisiones críticas (defaults; overridables)

| # | Decisión | Default propuesto | Cómo overridear |
|---|---|---|---|
| 1 | Símbolos por defecto | `['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT']` (sin SOL) | Admin por usuario, o re-habilitar global |
| 2 | Filtros BTC | ADX ≥ 18, EMA200 tol 1%, vol ≥ 0.9× | Por estrategia, no per-user |
| 3 | Margin type | `ISOLATED` (forzado) | No overridable; multi-tenant lo exige |
| 4 | Leverage default | `3x` (sin cambios) | Per-user, rango 1-10 |
| 5 | Risk per trade | `2%` del capital asignado | Per-user, rango 0.5-5% |
| 6 | Max positions concurrent | `3` | Per-user, rango 1-5 |
| 7 | Max daily loss | `5%` del capital asignado | Per-user, rango 2-10% |
| 8 | Trading allocation | `50%` del balance Binance del user | Per-user, rango 10-100% |
| 9 | Cron frequency | Cada 5 minutos | Solo admin global |
| 10 | Target marketing | "Objetivo 5-10% mensual sostenible, sin garantías" | Texto en UI/landing |

---

## 6. Bugs críticos del sistema actual a resolver

Estos son los hallazgos del audit del código actual. Cada uno tiene su task asignada en alguna fase.

| # | Bug | Archivo | Severidad | Fase |
|---|---|---|---|---|
| B1 | SL/TP solo en software, no nativos en Binance | `trading-engine.ts:265` | Crítico | 1 |
| B2 | Race condition: placeOrder → createTrade (DB fail = huérfano) | `trading-engine.ts:234-244` | Crítico | 1 |
| B3 | Daily loss check con signo invertido (nunca dispara) | `risk.ts:63` | Crítico | 1 |
| B4 | Sin idempotencia (`newClientOrderId` ausente) | `binance.ts:224-240` | Crítico | 1 |
| B5 | PnL al cierre usa precio actual, no fill real | `trading-engine.ts:335-336` | Alto | 1 |
| B6 | `stillOpenOnBinance` solo verifica por símbolo | `trading-engine.ts:318-320` | Alto | 1 |
| B7 | Capital double-counting: `marginBalance + unrealizedPnL` | `trading-engine.ts:78` | Alto | 1 |
| B8 | Trailing stop solo en software | `trading-engine.ts:374-386` | Alto | 1 |
| B9 | `calculateDailyLoss` ignora unrealized PnL | `risk.ts:103-108` | Medio | 1 |
| B10 | `marginType` mismatch silencioso (CROSS en prod, ISOLATED en schema) | `trading-engine.ts:211` | Medio | 1 |
| B11 | EMA200 tolerancia 3% (muy laxa) | `signals.ts:45-46` | Medio | 1 |
| B12 | `minSignalStrength = 52` (filtro inexistente) | `risk.ts:74` | Bajo | 1 |
| B13 | `kellyCriterion` implementado pero no usado | `risk.ts:114` | Bajo | 1 |
| B14 | Sin lock distribuido para cron concurrente | `cron/trade/route.ts` | Crítico | 3 |
| B15 | Schema singleton bloquea multi-tenant | `supabase/schema.sql:21` | Crítico | 2 |
| B16 | Sin auth, sin user concept | varios | Crítico | 2 |

---

## 7. Plan de fases

### Fase 1: Foundation refactor (4-7 días Claude Code)

**Objetivo**: arreglar bugs críticos de ejecución y migrar schema para que sea multi-tenant-ready, pero mantener el sistema operando single-user en Vercel temporalmente.

**Entregables**:
- Schema con columnas `user_id` en `trades`, `bot_logs`; nueva tabla `user_bot_config` (reemplaza singleton).
- Usuario "system" default insertado para mantener compatibilidad mientras se construye la auth.
- `binance.ts` refactorizado: idempotencia (clientOrderId), retry con backoff, native STOP_MARKET y TAKE_PROFIT_MARKET, helpers para querying userTrades.
- `risk.ts` refactorizado: fix bug daily loss, incluir unrealized PnL, remover dead code.
- `trading-engine.ts` reescrito como máquina de estados explícita: native SL/TP/trailing, reconciliación bidireccional, PnL desde userTrades reales.
- Bot sigue corriendo en Vercel cron + cron-job.org como hoy (NO se migra a Edge Functions en esta fase).
- Forward testing en testnet del refactor durante al menos 2 semanas antes de la fase 2.

**Spec detallado**: ver `01_PHASE_1_FOUNDATION.md`.

---

### Fase 2: Multi-tenant data & auth (3-5 días)

**Objetivo**: introducir Supabase Auth, panel super admin, gestión de usuarios y API keys cifradas.

**Entregables**:
- Supabase Auth habilitado (email + password, signup deshabilitado).
- Tabla `users` con rol `admin | trader`.
- Política RLS estricta: cada usuario solo ve sus propios trades, signals, configs.
- Tabla `user_api_keys` con referencia a Vault para cifrado de Binance API key/secret.
- `/admin` page: crear usuario, ver lista, ver una contraseña recién generada (one-time view), kill switch por usuario, kill switch global.
- `/dashboard` page: cada usuario ve solo lo suyo, configura su asignación de capital, enciende/apaga bot.
- API routes con verificación de JWT y rol.
- Migración del usuario "system" a un admin real (tú).

**Spec detallado**: pendiente, se entrega cuando se complete fase 1.

---

### Fase 3: Engine migration to Edge Functions (2-4 días)

**Objetivo**: mover el motor de Vercel cron a Supabase Edge Functions con pg_cron, multi-usuario.

**Entregables**:
- Edge Function `trading-tick` portada a Deno (TypeScript con imports Deno-compatible).
- pg_cron job ejecutando cada 5 minutos.
- pg_net + Vault para invocación segura.
- Lógica multi-user: fase compartida (señales) → fase per-user secuencial.
- Lock distribuido vía Postgres advisory locks o tabla `cron_locks`.
- Eliminar endpoints `/api/cron/*` y `/api/bot/tick/*` del frontend Vercel (queda solo dashboard).
- pg_cron job adicional: `cleanup-logs` (purga logs >7 días, signals >30 días).
- pg_cron job adicional: `compute-daily-metrics` por usuario (snapshot diario para reporting).

**Spec detallado**: pendiente.

---

### Fase 4: User dashboard polish (3-5 días)

**Objetivo**: dashboard del usuario con UX clara, conectado a la nueva BD multi-tenant.

**Entregables**:
- Onboarding al primer login: paso 1 conectar Binance keys, paso 2 elegir % de allocación, paso 3 firmar disclaimer.
- Vista principal: balance, capital asignado, bot on/off, posiciones abiertas con PnL en vivo (Realtime), señales recientes propias.
- Vista de historial: trades cerrados, filtros por símbolo/fecha, exportar CSV.
- Vista de métricas: win rate, profit factor, max DD, equity curve.
- Vista de logs: actividad reciente del bot relativa a este usuario.
- Settings: cambiar % allocación, cambiar password, eliminar API keys.

**Spec detallado**: pendiente.

---

### Fase 5: Pre-launch checklist (3-5 días)

**Objetivo**: cerrar todos los gates antes de aceptar usuarios reales con dinero real.

**Entregables**:
- Backtest histórico 12 meses con datos reales de Binance (Klines API es gratis).
- Forward test 4 semanas con bot real en mainnet con capital pequeño (tu propia cuenta).
- Modo "shadow trading" implementado: bot genera señales y registra qué hubiera hecho sin ejecutar.
- Disclaimer legal escrito y firmado por usuario antes de activar bot.
- Documentación de operación para admin: cómo crear usuarios, cómo monitorear, cómo responder a incidentes.
- Runbook de emergencia: qué hacer si Binance reporta downtime, si Supabase pausa, si Vercel cae.
- Auto-pausa por max drawdown total acumulado (-15% sobre capital asignado del usuario).
- Métricas de observabilidad: dashboard interno con health del sistema (última ejecución de cron, errores recientes, tasa de éxito de órdenes).

**Spec detallado**: pendiente.

---

## 8. Restricciones y compromisos

### De costo

- Etapa 1 (~3 meses, hasta 15-20 usuarios): $0 garantizado.
- Tope de DB: 500MB. Limpieza agresiva de logs (7 días) y signals (30 días) implementada en fase 3.
- Tope de Edge Function invocations: 500K/mes. A 5 min cron = ~8,640/mes, deja 491K de margen.
- Tope de auth MAU: 50K. Inalcanzable en etapa 1.
- Si se alcanza algún tope, plan B: Supabase Pro ($25/mes) o split entre dos proyectos free.

### De seguridad

- API keys de Binance JAMÁS en plaintext en BD, env vars o logs.
- Usar Supabase Vault con `decrypted_secrets` view, accesible solo desde Edge Function con service role key.
- API keys configuradas por usuario deben tener permisos mínimos en Binance: solo Futures Trading. Sin retiros, sin spot trading, sin transferencias.
- IP whitelist en Binance: se documentará al usuario las IPs de salida de Supabase Edge Functions (rango fijo).
- Logs nunca contienen secretos.

### De compliance / legal

- Producto positioning: "herramienta de automatización para que el usuario opere con sus propias API keys en su cuenta Binance". No custodia.
- Disclaimer obligatorio antes de primer trade real: usuario reconoce riesgo, acepta que no hay garantía de rendimientos, sabe que puede perder capital, declara que opera con dinero que puede permitirse perder.
- Sin garantías de rendimiento en ningún copy del producto.
- TOS de Vercel Hobby: explícitamente prohíbe uso comercial. En etapa 1 con dominio personal y bajo tráfico es zona gris. Plan de migración a Cloudflare Pages registrado como tech debt para activar antes de cobrar a usuarios.

---

## 9. Criterios de éxito por fase

### Fase 1

- [ ] 0 trades huérfanos en testnet durante 2 semanas de forward test.
- [ ] 100% de los trades cerrados tienen `binance_order_id`, `stop_order_id`, `tp1_order_id`, `tp2_order_id` poblados.
- [ ] PnL reportado en BD coincide (±0.5%) con PnL en el extracto de Binance.
- [ ] Daily loss limit dispara correctamente cuando se simula con trades de pérdida.
- [ ] Tests manuales documentados: matar el cron a mitad de un trade, verificar que SL nativo cierra la posición.

### Fase 2

- [ ] Admin puede crear un usuario nuevo, ver su password una vez, el usuario logea y solo ve sus datos.
- [ ] Usuario A no puede ver, modificar ni inferir datos de usuario B (test directo con SQL bypassing RLS confirmar denegación).
- [ ] API keys cifradas: leer la columna directamente en SQL retorna basura cifrada, solo descifra via función con service role.
- [ ] Kill switch global desactiva todos los bots en <30 segundos.

### Fase 3

- [ ] Engine corriendo en Edge Functions, Vercel cron eliminado.
- [ ] 5 usuarios simulados en testnet, tick completo termina en <60s consistentemente.
- [ ] Si un usuario tiene credenciales inválidas, los otros 4 siguen operando normalmente.
- [ ] Cron job no se solapa: dos ticks disparados simultáneamente, solo uno se ejecuta.

### Fase 4

- [ ] Onboarding de un usuario nuevo desde login hasta bot activo en <3 minutos.
- [ ] Dashboard renderiza en <1.5s en mobile.
- [ ] Realtime: una posición que cambia en BD se refleja en el dashboard en <2s.

### Fase 5

- [ ] Backtest sobre 12 meses arroja métricas comparables o mejores a 1.0 profit factor.
- [ ] Forward test 4 semanas: 0 incidentes de ejecución, win rate >35% sostenido.
- [ ] Runbook validado con un simulacro de incidente (apagar Supabase project a propósito, verificar recovery).

---

## 10. Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| La estrategia no tiene edge real (muestra insuficiente) | Media | Crítico | Fase 5 backtest 12 meses antes de aceptar usuarios reales |
| Vercel flagea uso comercial | Baja en etapa 1 | Alto | Migración a Cloudflare Pages preparada como plan B |
| Supabase free pausa proyecto | Baja (con bot activo) | Alto | Bot mantiene actividad; monitor de health adicional |
| Binance cambia API o limita IPs | Media | Medio | Tests automáticos en cada tick verifican conectividad |
| Usuario perdió dinero, busca culpable legal | Media (cualquier SaaS de trading) | Alto | Disclaimer firmado, no custodia, positioning claro de herramienta |
| Bug introducido en deploy mata múltiples cuentas | Media | Crítico | Feature flag por usuario; deploys graduales; modo shadow disponible |
| Saturación de invocations Edge Function | Baja | Medio | Optimización: cache de klines, fan-out con pgmq en fase posterior |
| Pérdida de API keys (Vault failure) | Muy baja | Crítico | Vault es Postgres + extension; backup diario nativo Supabase |

---

## 11. Decisiones pendientes que requieren tu input

Antes de cerrar fase 1, confirmar o ajustar:

- [ ] Confirmar **SOL excluido** del default (mi recomendación: sí).
- [ ] Confirmar **BTC incluido con filtros relajados** (mi recomendación: sí).
- [ ] Confirmar **ISOLATED como margin type forzado** (mi recomendación: sí).
- [ ] Confirmar **trading allocation %** como modelo de capital (mi recomendación: sí, default 50%).
- [ ] Confirmar **eliminar el "15-30% mensual"** del marketing (mi recomendación: sí).

Si todas son sí, fase 1 puede arrancar directamente con `01_PHASE_1_FOUNDATION.md`.
