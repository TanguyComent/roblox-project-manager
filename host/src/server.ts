import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { config } from './config.ts'
import { openDb } from './db.ts'
import { purgeExpiredSessions } from './auth.ts'
import { WorkerHub } from './worker-hub.ts'

const db = openDb()
purgeExpiredSessions(db)
setInterval(() => purgeExpiredSessions(db), 3600_000).unref()

const hub = new WorkerHub(db)
const server = serve({ fetch: createApp(db, { hub }).fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[host] http://${info.address}:${info.port}  (public : ${config.publicUrl})`)
})
hub.attach(server as Server) // serveur HTTP/1 (pas de TLS ici : il est assure par le reverse proxy)
