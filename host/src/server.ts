import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { config } from './config.ts'
import { openDb } from './db.ts'
import { purgeExpiredSessions } from './auth.ts'

const db = openDb()
purgeExpiredSessions(db)
setInterval(() => purgeExpiredSessions(db), 3600_000).unref()

serve({ fetch: createApp(db).fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[host] http://${info.address}:${info.port}  (public : ${config.publicUrl})`)
})
