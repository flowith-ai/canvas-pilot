#!/usr/bin/env bun
/**
 * Canvas Bot CLI — Zero-dependency Flowith canvas control
 *
 * Native WebSocket + fetch + http only. No npm packages.
 * Works with: Bun (any), Node 22+
 *
 * Session is auto-created via browser handshake — no credentials needed.
 */

import { existsSync, readFileSync, writeFileSync, statSync, chmodSync, unlinkSync, mkdirSync } from "fs"
import { createServer } from "http"
import { resolve, join, basename, extname } from "path"
import { homedir } from "os"

// ============ Runtime check ============

if (typeof globalThis.WebSocket === "undefined") {
  console.error("Error: WebSocket not available. Use bun or Node 22+.")
  process.exit(1)
}

// ============ Types ============

interface CanvasBotSession {
  sessionId: string
  sessionSecret: string
  supabaseUrl: string
  supabaseKey: string
  accessToken: string
  workerURL?: string
  activeConvId?: string
  createdAt: string
  expiresAt: string
  lastBrowserOpenAt?: string
}

interface BotActionBase { actionId: string; sessionId: string; timestamp: string }
type BotAction = BotActionBase &
  (
    | { type: "ping" }
    | { type: "register_session"; expiresAt: string; sessionSecret: string; botClient?: string }
    | { type: "create_canvas"; title?: string }
    | { type: "switch_canvas"; convId: string }
    | { type: "list_models"; chatMode?: string }
    | { type: "list_canvases" }
    | { type: "search_canvases"; query: string }
    | { type: "read_nodes"; convId: string; nodeId?: string; full?: boolean; failed?: boolean }
    | { type: "poll_generation"; convId: string; createdAfter: string; parentId?: string }
    | { type: "recall"; query: string; limit?: number; filters?: Record<string, unknown> }
    | { type: "recall_node"; convId: string; nodeId: string }
    | { type: "clean_failed"; convId: string }
    | { type: "set_mode"; mode: string }
    | { type: "set_model"; model: string }
    | { type: "select_node"; nodeId: string }
    | { type: "deselect" }
    | { type: "submit"; value: string; files?: Array<{ url: string; name: string; type?: string }> }
    | { type: "delete_node"; nodeId: string }
    | { type: "delete_nodes"; nodeIds: string[] }
    | { type: "read_node"; nodeId: string }
    | { type: "read_all_nodes" }
  )
type BotActionPayload<T = BotAction> = T extends BotActionBase ? Omit<T, keyof BotActionBase> : never
type BotResponse =
  | { type: "ack"; actionId: string }
  | { type: "result"; actionId: string; data: unknown }
  | { type: "error"; actionId: string; code: string; message: string }
  | { type: "pong"; actionId: string }

// ============ Constants ============

const SESSION_DIR = join(homedir(), ".flowith")
const SESSION_FILE = join(SESSION_DIR, "bot-session.json")
const SESSION_LOCK_FILE = join(SESSION_DIR, "bot-session.lock")
const LEGACY_SESSION_FILE = ".flowith-bot-session.json"
const BOT_EVENTS = { ACTION: "bot_action", RESPONSE: "bot_response" } as const
const ACTION_TIMEOUT_MS = 30_000
const ORACLE_TIMEOUT_MS = 120_000
const HEARTBEAT_MS = 29_000
const QUICK_PING_MS = 3_000
const BROWSER_OPEN_WAIT_MS = 25_000
const BROWSER_POLL_MS = 2_000
const BROWSER_OPEN_COOLDOWN_MS = 60_000
const VALID_MODES = new Set(["text", "image", "video", "agent", "neo"])

// Input validation
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function assertUUID(value: string, label: string) {
  if (!UUID_RE.test(value)) throw new Error(`Invalid ${label}: expected UUID, got "${value}"`)
}

// Resolve Flowith URL: env override or deployed preview
async function detectFlowithUrl(): Promise<string> {
  if (process.env.FLOWITH_URL) return process.env.FLOWITH_URL
  return "https://feat-canvas-skill.hypergpt-frontend.pages.dev"
}
let _flowithUrl: string | null = null
async function getFlowithUrl(): Promise<string> {
  if (!_flowithUrl) _flowithUrl = await detectFlowithUrl()
  return _flowithUrl
}

// ============ Minimal Supabase Realtime (Phoenix Channel) ============

class RealtimeLite {
  private ws!: WebSocket
  private ref = 0
  private joinRefs = new Map<string, string>()
  private hb?: ReturnType<typeof setInterval>
  private listeners: Array<(m: any) => void> = []
  private joinedSet = new Set<string>()
  constructor(private url: string, private key: string, private token: string) {}
  connect(): Promise<void> {
    const ws = this.url.replace("https://", "wss://").replace("http://", "ws://")
    return new Promise((res, rej) => {
      this.ws = new WebSocket(`${ws}/realtime/v1/websocket?apikey=${encodeURIComponent(this.key)}&vsn=1.0.0`)
      const t = setTimeout(() => rej(new Error("WS timeout")), 10_000)
      this.ws.onopen = () => { clearTimeout(t); this.hb = setInterval(() => this.push("phoenix", "heartbeat", {}), HEARTBEAT_MS); res() }
      this.ws.onmessage = (e: MessageEvent) => { try { const m = JSON.parse(String(e.data)); for (const f of this.listeners) f(m) } catch {} }
      this.ws.onerror = () => { clearTimeout(t); rej(new Error("WS failed")) }
      this.ws.onclose = () => { if (this.hb) clearInterval(this.hb) }
    })
  }
  join(ch: string): Promise<void> {
    if (this.joinedSet.has(ch)) return Promise.resolve()
    const ref = String(++this.ref); this.joinRefs.set(ch, ref)
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`Join timeout: ${ch}`)), 10_000)
      const h = (m: any) => { if (m.ref === ref && m.event === "phx_reply") { clearTimeout(t); this.listeners = this.listeners.filter(l => l !== h); if (m.payload?.status === "ok") { this.joinedSet.add(ch); res() } else rej(new Error("Join failed")) } }
      this.listeners.push(h)
      this.push(`realtime:${ch}`, "phx_join", { config: { broadcast: { self: false }, presence: { key: "" }, postgres_changes: [] }, access_token: this.token }, ref, ref)
    })
  }
  broadcast(ch: string, event: string, payload: unknown) { this.push(`realtime:${ch}`, "broadcast", { type: "broadcast", event, payload }, undefined, this.joinRefs.get(ch)) }
  onBroadcast(ch: string, event: string, cb: (p: any) => void): () => void { const h = (m: any) => { if (m.topic === `realtime:${ch}` && m.event === "broadcast" && m.payload?.event === event) cb(m.payload.payload) }; this.listeners.push(h); return () => { this.listeners = this.listeners.filter(l => l !== h) } }
  close() { if (this.hb) clearInterval(this.hb); try { this.ws?.close() } catch {} }
  private push(topic: string, event: string, payload: unknown, ref?: string, jr?: string) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ topic, event, payload, ref: ref ?? String(++this.ref), join_ref: jr ?? null })) }
}

// ============ Bot client identity ============

function parseBotClient(rawArgs: string[]): { args: string[]; botClient: string } {
  const idx = rawArgs.indexOf("--bot")
  if (idx !== -1 && rawArgs[idx + 1]) {
    return { botClient: rawArgs[idx + 1], args: [...rawArgs.slice(0, idx), ...rawArgs.slice(idx + 2)] }
  }
  return { botClient: process.env.BOT_CLIENT || "other", args: rawArgs }
}

// ============ Browser open helper ============

async function openInBrowser(url: string) {
  const { spawnSync } = await import("child_process")
  if (process.platform === "darwin") {
    spawnSync("open", [url], { stdio: "ignore" })
  } else if (process.platform === "win32") {
    // cmd.exe treats & | < > ^ as metacharacters; escape with ^ to prevent URL breakage
    const escaped = url.replace(/[&|<>^]/g, "^$&")
    spawnSync("cmd", ["/c", "start", "", escaped], { stdio: "ignore" })
  } else {
    spawnSync("xdg-open", [url], { stdio: "ignore" })
  }
}

// ============ JWT helpers ============

function decodeJwt(jwt: string): any { try { return JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) } catch { return null } }
function getJwtUserId(jwt: string): string | null { return decodeJwt(jwt)?.sub ?? null }
function isJwtExpired(jwt: string): boolean { const p = decodeJwt(jwt); return p?.exp ? p.exp * 1000 < Date.now() : false }

// ============ Session I/O ============

function saveSession(s: CanvasBotSession) {
  mkdirSync(SESSION_DIR, { recursive: true })
  writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2))
  try { chmodSync(SESSION_FILE, 0o600) } catch {}
}

function loadSession(): CanvasBotSession | null {
  // Migrate legacy session from cwd if new location doesn't exist
  if (!existsSync(SESSION_FILE)) {
    const legacy = resolve(process.cwd(), LEGACY_SESSION_FILE)
    if (existsSync(legacy)) {
      try {
        mkdirSync(SESSION_DIR, { recursive: true })
        writeFileSync(SESSION_FILE, readFileSync(legacy, "utf-8"))
        try { chmodSync(SESSION_FILE, 0o600) } catch {}
        unlinkSync(legacy)
        console.error(`Migrated session from ${legacy} to ${SESSION_FILE}`)
      } catch {}
    }
  }
  if (!existsSync(SESSION_FILE)) return null
  try { const s = statSync(SESSION_FILE); if (s.mode & 0o077) chmodSync(SESSION_FILE, 0o600) } catch {}
  try {
    const s: CanvasBotSession = JSON.parse(readFileSync(SESSION_FILE, "utf-8"))
    if (!s.sessionId || !s.sessionSecret || !s.supabaseUrl || !s.accessToken) return null
    if (new Date(s.expiresAt).getTime() < Date.now() || isJwtExpired(s.accessToken)) return null
    return s
  } catch { return null }
}

// ============ Token validation ============

async function validateToken(session: CanvasBotSession): Promise<boolean> {
  try {
    const r = await fetch(
      `${session.supabaseUrl}/rest/v1/conversation?select=id&limit=1`,
      {
        headers: { apikey: session.supabaseKey, Authorization: `Bearer ${session.accessToken}` },
        signal: AbortSignal.timeout(5_000),
      },
    )
    // 401/403 = token revoked or expired server-side
    return r.status !== 401 && r.status !== 403
  } catch {
    // Network error — don't block, let it fail naturally later
    return true
  }
}

// ============ Browser handshake: local HTTP server receives session from frontend ============

async function acquireSession(botClient = "other"): Promise<CanvasBotSession> {
  const existing = loadSession()
  if (existing) {
    // Quick server-side token validation (catches revoked/expired tokens the JWT check misses)
    const valid = await validateToken(existing)
    if (valid) return existing
    // Token rejected — clear stale session
    deleteSessionFile()
    console.error("Session token expired or revoked. Re-authenticating...")
  }

  // Lockfile guard: if another CLI process is already opening the browser, wait for it
  if (!tryAcquireSessionLock()) {
    return waitForSessionFromOtherProcess()
  }

  console.error("No valid session. Opening Flowith in your browser...")
  console.error("Please log in if needed — the connection will complete automatically.\n")

  // One-time nonce: browser must echo this back to prove it was opened by this CLI instance
  const nonce = crypto.randomUUID()

  return new Promise((resolvePromise, reject) => {
    let settled = false
    const fail = (msg: string, code?: string) => { if (!settled) { settled = true; clearTimeout(timeout); server.close(); releaseSessionLock(); reject(code ? new BrowserConnectionError(msg, code) : new Error(msg)) } }
    const succeed = (s: CanvasBotSession) => { if (!settled) { settled = true; clearTimeout(timeout); server.close(); releaseSessionLock(); resolvePromise(s) } }

    const timeout = setTimeout(() => fail(
      "Browser did not send session within 2 minutes.\n\n" +
      "This usually means you are not logged in to Flowith.\n" +
      "Please log in at the browser window that was opened, then re-run this command.",
      "NOT_LOGGED_IN",
    ), 120_000)

    const server = createServer((req, res) => {
      // CORS: restrict to known Flowith origins + localhost dev servers
      const origin = req.headers.origin || ""
      const allowedOrigins = [
        /^https?:\/\/localhost(:\d+)?$/,
        /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
        /^https:\/\/([a-z0-9-]+\.)?flowith\.(io|net)$/,
        /^https:\/\/[a-z0-9-]+\.hypergpt-frontend\.pages\.dev$/,
      ]
      const corsOrigin = allowedOrigins.some(r => r.test(origin)) ? origin : ""
      res.setHeader("Access-Control-Allow-Origin", corsOrigin)
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
      res.setHeader("Access-Control-Allow-Headers", "Content-Type")
      res.setHeader("Vary", "Origin")

      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return }

      // Frontend reports user is not logged in → keep waiting (user can log in in the browser)
      if (req.method === "POST" && req.url === "/not-logged-in") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
        console.error("Not logged in yet. Please log in at the browser window — waiting for you...")
        return
      }

      if (req.method === "POST" && req.url === "/session") {
        let body = ""
        req.on("data", (c: Buffer) => { body += c.toString() })
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body)
            // Validate nonce to prevent other local processes from injecting sessions
            if (parsed.nonce !== nonce) {
              res.writeHead(403, { "Content-Type": "application/json" })
              res.end(JSON.stringify({ error: "Invalid nonce" }))
              return
            }
            const { nonce: _, ...sessionData } = parsed as CanvasBotSession & { nonce: string }
            const session: CanvasBotSession = { ...sessionData, sessionSecret: crypto.randomUUID(), lastBrowserOpenAt: new Date().toISOString() }
            saveSession(session)
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ ok: true }))
            console.error("Session received from browser. Connected!")
            succeed(session)
          } catch {
            res.writeHead(400); res.end("Invalid session")
          }
        })
        return
      }
      res.writeHead(404); res.end()
    })

    server.listen(0, "127.0.0.1", async () => {
      const port = (server.address() as any).port
      const base = await getFlowithUrl()
      const url = `${base}?cli_port=${port}&cli_nonce=${nonce}&cli_bot=${encodeURIComponent(botClient)}`
      await openInBrowser(url)
      console.error(`Waiting for browser at ${url} ...`)
    })
  })
}

// ============ Register session with frontend via broadcast ============

async function registerWithFrontend(client: RealtimeLite, session: CanvasBotSession, userId: string, botClient: string) {
  const ch = `bot_ctrl:${userId}`
  await client.join(ch)
  const actionId = crypto.randomUUID()
  const action: BotAction = { actionId, sessionId: session.sessionId, timestamp: new Date().toISOString(), type: "register_session", expiresAt: session.expiresAt, sessionSecret: session.sessionSecret, botClient }
  let cleanup: (() => void) | undefined
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      cleanup = client.onBroadcast(ch, BOT_EVENTS.RESPONSE, (resp: BotResponse) => {
        if (resp.actionId !== actionId) return
        cleanup?.()
        if (resp.type === "ack") resolve()
        else if (resp.type === "error") reject(new Error(`Session registration rejected: ${(resp as any).message || (resp as any).code}`))
      })
      client.broadcast(ch, BOT_EVENTS.ACTION, action)
    }),
    new Promise<void>(r => setTimeout(r, 3_000)), // No browser yet — ensureBrowserConnected will handle it
  ])
  cleanup?.() // Clean up listener if timeout won the race
}

// ============ Typed errors ============

class BrowserConnectionError extends Error {
  constructor(message: string, public code: string = "BROWSER_CONNECTION_ERROR") { super(message); this.name = "BrowserConnectionError" }
}

function deleteSessionFile() {
  try { unlinkSync(SESSION_FILE) } catch {}
}

// ============ Session lock (prevents concurrent browser opens) ============

const SESSION_LOCK_MAX_AGE_MS = 120_000
const SESSION_LOCK_POLL_MS = 1_000

/** Try to acquire the session lock. Returns false if another process holds it. */
function tryAcquireSessionLock(): boolean {
  mkdirSync(SESSION_DIR, { recursive: true })
  if (existsSync(SESSION_LOCK_FILE)) {
    try {
      const s = statSync(SESSION_LOCK_FILE)
      if (Date.now() - s.mtimeMs < SESSION_LOCK_MAX_AGE_MS) return false // held by another process
    } catch {}
  }
  try { writeFileSync(SESSION_LOCK_FILE, String(process.pid)); return true } catch { return false }
}

function releaseSessionLock() {
  try { unlinkSync(SESSION_LOCK_FILE) } catch {}
}

/** Wait for another process to finish acquiring the session. */
async function waitForSessionFromOtherProcess(): Promise<CanvasBotSession> {
  console.error("Another process is opening the browser. Waiting for session...")
  const deadline = Date.now() + SESSION_LOCK_MAX_AGE_MS
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, SESSION_LOCK_POLL_MS))
    const session = loadSession()
    if (session) {
      const valid = await validateToken(session)
      if (valid) { console.error("Session ready."); return session }
    }
    // Lock released but no valid session → stale lock, break and proceed
    if (!existsSync(SESSION_LOCK_FILE)) break
  }
  throw new Error("Timed out waiting for session from another process. Please retry.")
}

// ============ Creative Dream (journal I/O) ============

const JOURNAL_FILE = join(SESSION_DIR, "creative-journal.md")

// ============ Pre-flight: auto-detect & auto-open browser ============

async function quickPing(client: RealtimeLite, ch: string, session: CanvasBotSession): Promise<boolean> {
  try {
    const action: BotAction = { actionId: crypto.randomUUID(), sessionId: session.sessionId, timestamp: new Date().toISOString(), type: "ping" }
    await sendAndWait(client, ch, action, QUICK_PING_MS)
    return true
  } catch { return false }
}

async function ensureBrowserConnected(client: RealtimeLite, session: CanvasBotSession, userId: string, botClient: string): Promise<void> {
  const ch = `bot_ctrl:${userId}`
  if (await quickPing(client, ch, session)) return

  // Decide: open browser or just wait (if we or another process already opened it recently)
  // session is passed by reference — in-process retries see the updated timestamp without re-reading the file.
  // saveSession() persists it so separate CLI invocations also respect the cooldown.
  const now = Date.now()
  const recentlyOpened = session.lastBrowserOpenAt &&
    now - new Date(session.lastBrowserOpenAt).getTime() < BROWSER_OPEN_COOLDOWN_MS

  if (!recentlyOpened) {
    const base = await getFlowithUrl()
    const target = session.activeConvId ? `${base}/conv/${session.activeConvId}` : base
    console.error("Browser not connected. Opening Flowith...")
    await openInBrowser(target)
    session.lastBrowserOpenAt = new Date().toISOString()
    saveSession(session)
  } else {
    console.error("Browser was recently opened. Waiting for it to connect...")
  }

  // Poll until browser mounts and responds
  const deadline = Date.now() + BROWSER_OPEN_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, BROWSER_POLL_MS))
    await registerWithFrontend(client, session, userId, botClient)
    if (await quickPing(client, ch, session)) { console.error("Connected!"); return }
  }

  // Timed out — determine root cause: token expired (not logged in) vs browser issue
  const tokenValid = await validateToken(session)
  if (!tokenValid) {
    // Token rejected → user is not logged in or session expired
    deleteSessionFile()
    throw new BrowserConnectionError(
      "Your Flowith session has expired or you are not logged in.\n\n" +
      "Please open Flowith in your browser, log in, then re-run this command.",
      "NOT_LOGGED_IN",
    )
  }
  throw new BrowserConnectionError(
    "Browser opened but did not respond.\n\n" +
    "Please ensure the Flowith tab is fully loaded and you are logged in.",
    "BROWSER_NOT_CONNECTED",
  )
}

// ============ Connect + Execute with auto-retry ============

const MAX_RETRIES = 2

async function connectAndExecute(session: CanvasBotSession, userId: string, channelName: string, action: BotAction, timeout: number, botClient: string): Promise<BotResponse> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const client = new RealtimeLite(session.supabaseUrl, session.supabaseKey, session.accessToken)
    try {
      await client.connect()
      await registerWithFrontend(client, session, userId, botClient)
      await ensureBrowserConnected(client, session, userId, botClient)
      if (!channelName.startsWith("bot_ctrl:")) await client.join(channelName)
      return await sendAndWait(client, channelName, action, timeout)
    } catch (e: any) {
      lastError = e
      // Browser timeout = we already opened + waited long enough — retrying won't help
      if (e instanceof BrowserConnectionError) throw e
      if (attempt < MAX_RETRIES) {
        console.error(`Connection failed (${e.message}), retrying... (${attempt + 1}/${MAX_RETRIES})`)
      }
    } finally {
      client.close()
    }
  }

  throw lastError ?? new Error("Connection failed after retries")
}

// ============ Image upload ============

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "svg", "bmp", "avif", "heic"])
const IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
  bmp: "image/bmp", avif: "image/avif", heic: "image/heic",
}
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

function isUrl(s: string): boolean { return /^https?:\/\//i.test(s) }

type SubmitFile = { url: string; name: string; type?: string }

/** Upload a local file via the same /file/store endpoint the frontend uses. */
async function uploadToWorker(filePath: string, session: CanvasBotSession): Promise<SubmitFile> {
  const workerURL = session.workerURL
  if (!workerURL) throw new Error("Session missing workerURL — re-run to get a fresh session from the browser")

  const absPath = resolve(filePath)
  if (!existsSync(absPath)) throw new Error(`File not found: ${filePath}`)

  const ext = extname(absPath).slice(1).toLowerCase()
  if (!IMAGE_EXTS.has(ext)) throw new Error(`Not an image file: ${filePath} (supported: ${[...IMAGE_EXTS].join(", ")})`)

  const fileData = readFileSync(absPath)
  if (fileData.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(`File too large: ${(fileData.byteLength / 1024 / 1024).toFixed(1)}MB (max ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)`)
  }

  const fileName = basename(absPath)
  const contentType = IMAGE_MIME[ext] || "application/octet-stream"
  console.error(`Uploading ${fileName} (${(fileData.byteLength / 1024).toFixed(0)}KB)...`)

  // Replicate what the frontend's storeFile() does: POST FormData to /file/store
  const blob = new Blob([fileData], { type: contentType })
  const formData = new FormData()
  formData.append("file", blob, fileName)

  const resp = await fetch(`${workerURL}/file/store`, {
    method: "POST",
    headers: { Authorization: session.accessToken },
    body: formData,
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`Upload failed (${resp.status}): ${text}`)
  }

  const { url } = await resp.json() as { url: string }
  console.error(`Uploaded → ${url}`)
  return { url, name: fileName, type: contentType }
}

async function resolveImages(paths: string[], session: CanvasBotSession): Promise<SubmitFile[]> {
  return Promise.all(paths.map(async (p): Promise<SubmitFile> => {
    if (isUrl(p)) {
      return { url: p, name: p.split("/").pop()?.split("?")[0] || "image" }
    }
    return uploadToWorker(p, session)
  }))
}

function extractFlag(args: string[], flag: string): { values: string[]; rest: string[] } {
  const values: string[] = [], rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] && !args[i + 1].startsWith("--")) {
      values.push(args[i + 1]); i++
    } else { rest.push(args[i]) }
  }
  return { values, rest }
}

// ============ Main ============

async function main() {
  const { args, botClient } = parseBotClient(process.argv.slice(2))
  if (!args.length || args[0] === "-h" || args[0] === "--help") { printUsage(); process.exit(args.length ? 0 : 1) }
  const cmd = args[0]

  // ---- status ----
  if (cmd === "status") {
    const s = loadSession()
    console.log(JSON.stringify(s ? { status: "ok", activeConvId: s.activeConvId ?? null, expiresAt: s.expiresAt } : { status: "no_session" }))
    return
  }

  // ---- open ----
  if (cmd === "open") {
    const base = await getFlowithUrl()
    const existing = loadSession()
    const convId = args[1] || existing?.activeConvId
    const target = convId ? `${base}/conv/${convId}` : base
    await openInBrowser(target)
    // Record browser open so ensureBrowserConnected() cooldown prevents duplicate tabs
    if (existing) {
      existing.lastBrowserOpenAt = new Date().toISOString()
      if (args[1]) existing.activeConvId = args[1]
      saveSession(existing)
    }
    console.error(`Opened ${target}`)
    return
  }

  // ---- dream-init (file I/O only, no session needed) ----
  if (cmd === "dream-init") {
    const theme = args[1]
    if (!theme) { console.error("Usage: dream-init \"theme\" [--mode image|video|text]"); process.exit(1) }
    const mi = args.indexOf("--mode")
    const mode = (mi !== -1 && args[mi + 1]) ? args[mi + 1] : "image"
    const el = theme.split(/[\s×x+&,、·:]+/).filter(Boolean)
    const elStr = el.join(", ")
    const md = [
      `# Creative Journal`,
      ``,
      `## Meta`,
      `- theme: ${theme}`,
      `- mode: ${mode}`,
      `- round: 0`,
      `- canvasId:`,
      `- createdAt: ${new Date().toISOString()}`,
      ``,
      `## Directions`,
      ``,
      `### d1: ${theme}`,
      `- base: ${theme}`,
      `- elements: ${elStr}`,
      `- status: new`,
      `- score: 0`,
      `- rounds: 0`,
      ``,
      `## History`,
      ``,
      `(none yet)`,
      ``,
      `## Config`,
      `- pauseStreakBelow: 4`,
      `- pauseStreakLength: 3`,
      ``,
    ].join("\n")
    mkdirSync(SESSION_DIR, { recursive: true })
    writeFileSync(JOURNAL_FILE, md)
    console.log(JSON.stringify({ type: "result", actionId: crypto.randomUUID(), data: { theme, mode, directions: ["d1"], journal: JOURNAL_FILE } }, null, 2))
    return
  }

  // ---- All other commands: acquire session (auto-handshake if needed) ----
  const session = await acquireSession(botClient)
  const userId = getJwtUserId(session.accessToken)
  if (!userId) { console.error("Error: Invalid token."); process.exit(1) }

  // ---- list ----
  if (cmd === "list") {
    const action: BotAction = { actionId: crypto.randomUUID(), sessionId: session.sessionId, timestamp: new Date().toISOString(), type: "list_canvases" }
    const result = await connectAndExecute(session, userId, `bot_ctrl:${userId}`, action, ACTION_TIMEOUT_MS, botClient)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  // ---- search ----
  if (cmd === "search") {
    if (!args[1]) { console.error("Error: search requires a query string."); process.exit(1) }
    const action: BotAction = { actionId: crypto.randomUUID(), sessionId: session.sessionId, timestamp: new Date().toISOString(), type: "search_canvases", query: args[1] }
    const result = await connectAndExecute(session, userId, `bot_ctrl:${userId}`, action, ACTION_TIMEOUT_MS, botClient)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  // ---- recall (via browser control channel) ----
  if (cmd === "recall") {
    const hasQuery = args[1] !== undefined && !args[1].startsWith("--")
    const query = hasQuery ? args[1] : ""
    const flags = args.slice(hasQuery ? 2 : 1)
    let limit = 10; let filterType: string | undefined; let filterConvId: string | undefined
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--limit" && flags[i + 1]) { limit = parseInt(flags[i + 1], 10); i++ }
      else if (flags[i] === "--type" && flags[i + 1]) { filterType = flags[i + 1]; i++ }
      else if (flags[i] === "--conv" && flags[i + 1]) { filterConvId = flags[i + 1]; i++ }
    }
    if (filterConvId) assertUUID(filterConvId, "convId")
    const filters: Record<string, unknown> = {}
    if (filterType) filters.types = [filterType]
    if (filterConvId) filters.convId = filterConvId
    const action: BotAction = { actionId: crypto.randomUUID(), sessionId: session.sessionId, timestamp: new Date().toISOString(), type: "recall", query, limit, filters: Object.keys(filters).length > 0 ? filters : undefined }
    const result = await connectAndExecute(session, userId, `bot_ctrl:${userId}`, action, ACTION_TIMEOUT_MS, botClient)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  // ---- recall-node (via browser control channel) ----
  if (cmd === "recall-node") {
    const convId = args[1]; const nodeId = args[2]
    if (!convId || !nodeId) { console.error("Error: recall-node requires <convId> <nodeId>."); process.exit(1) }
    assertUUID(convId, "convId"); assertUUID(nodeId, "nodeId")
    const action: BotAction = { actionId: crypto.randomUUID(), sessionId: session.sessionId, timestamp: new Date().toISOString(), type: "recall_node", convId, nodeId }
    const result = await connectAndExecute(session, userId, `bot_ctrl:${userId}`, action, ACTION_TIMEOUT_MS, botClient)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  // ---- read-db (via browser) ----
  if (cmd === "read-db") {
    if (!session.activeConvId) { console.error("Error: No active canvas. Run: create-canvas or list → switch <id>"); process.exit(1) }
    const convId = session.activeConvId
    assertUUID(convId, "activeConvId")
    const flags = new Set(args.slice(1).filter(a => a.startsWith("--")))
    const positional = args.slice(1).find(a => !a.startsWith("--"))
    if (positional) assertUUID(positional, "nodeId")
    const action: BotAction = { actionId: crypto.randomUUID(), sessionId: session.sessionId, timestamp: new Date().toISOString(), type: "read_nodes", convId, nodeId: positional, full: flags.has("--full"), failed: flags.has("--failed") }
    const result = await connectAndExecute(session, userId, `bot_ctrl:${userId}`, action, ACTION_TIMEOUT_MS, botClient)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  // ---- clean-failed (via browser control channel) ----
  if (cmd === "clean-failed") {
    if (!session.activeConvId) { console.error("Error: No active canvas. Run: create-canvas or list → switch <id>"); process.exit(1) }
    assertUUID(session.activeConvId, "activeConvId")
    const action: BotAction = { actionId: crypto.randomUUID(), sessionId: session.sessionId, timestamp: new Date().toISOString(), type: "clean_failed", convId: session.activeConvId }
    const result = await connectAndExecute(session, userId, `bot_ctrl:${userId}`, action, ACTION_TIMEOUT_MS, botClient)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  // ---- submit-batch: fire N submits over one connection ----
  if (cmd === "submit-batch") {
    const prompts = args.slice(1).filter(a => !a.startsWith("--"))
    if (!prompts.length) { console.error("Error: submit-batch requires at least one prompt.\nUsage: submit-batch \"prompt1\" \"prompt2\" ..."); process.exit(1) }
    if (!session.activeConvId) { console.error("Error: No active canvas."); process.exit(1) }
    assertUUID(session.activeConvId, "activeConvId")
    const ch = `bot:${session.activeConvId}`

    const client = new RealtimeLite(session.supabaseUrl, session.supabaseKey, session.accessToken)
    try {
      await client.connect()
      await registerWithFrontend(client, session, userId, botClient)
      await ensureBrowserConnected(client, session, userId, botClient)
      await client.join(ch)

      const results: Array<{ prompt: string; questionNodeId?: string; success: boolean }> = []
      const makeAction = (fields: BotActionPayload): BotAction =>
        ({ actionId: crypto.randomUUID(), sessionId: session.sessionId, timestamp: new Date().toISOString(), ...fields } as BotAction)

      for (let i = 0; i < prompts.length; i++) {
        // Deselect to create independent branches
        await sendAndWait(client, ch, makeAction({ type: "deselect" }), ACTION_TIMEOUT_MS)

        // Submit without waiting for generation
        const submitAction = makeAction({ type: "submit", value: prompts[i] })
        const resp = await sendAndWait(client, ch, submitAction, ORACLE_TIMEOUT_MS)
        const qid = resp.type === "result" ? (resp.data as any)?.questionNodeId : undefined
        const ok = resp.type === "result" && (resp.data as any)?.success !== false
        results.push({ prompt: prompts[i], questionNodeId: qid, success: ok })
        console.error(`  [${i + 1}/${prompts.length}] ${ok ? "✓" : "✗"} ${prompts[i].slice(0, 40)}...`)

        // Brief pause so the cursor doesn't look frantic
        if (i < prompts.length - 1) await new Promise(r => setTimeout(r, 500))
      }
      console.log(JSON.stringify({ type: "result", actionId: crypto.randomUUID(), data: { submitted: results.length, results } }, null, 2))
    } finally {
      client.close()
    }
    return
  }

  // Build action
  const actionId = crypto.randomUUID()
  const base: BotActionBase = { actionId, sessionId: session.sessionId, timestamp: new Date().toISOString() }
  let action: BotAction
  let channelName: string
  let timeout = ACTION_TIMEOUT_MS

  const requireCanvas = () => { if (!session.activeConvId) { console.error("Error: No active canvas. Run: create-canvas or list → switch <id>"); process.exit(1) }; assertUUID(session.activeConvId!, "activeConvId") }
  const canvasCh = () => `bot:${session.activeConvId}`

  switch (cmd) {
    // -- Control channel (any page) --
    case "ping": action = { ...base, type: "ping" }; channelName = `bot_ctrl:${userId}`; break
    case "create-canvas": {
      const rawTitle = args[1] || "Untitled"
      const title = rawTitle.startsWith("[") ? rawTitle : `[Bot] ${rawTitle}`
      action = { ...base, type: "create_canvas", title }; channelName = `bot_ctrl:${userId}`; break
    }
    case "switch": {
      if (!args[1]) { console.error("Error: switch requires convId."); process.exit(1) }
      assertUUID(args[1], "convId")
      session.activeConvId = args[1]; saveSession(session)
      action = { ...base, type: "switch_canvas", convId: args[1] }; channelName = `bot_ctrl:${userId}`; break
    }
    case "list-models": {
      action = { ...base, type: "list_models", chatMode: args[1] }; channelName = `bot_ctrl:${userId}`; break
    }

    // -- Canvas channel: atomic store operations --
    case "set-mode": {
      if (!args[1]) { console.error("Error: set-mode requires mode (text|image|video|agent|neo)."); process.exit(1) }
      if (!VALID_MODES.has(args[1])) { console.error(`Error: invalid mode "${args[1]}". Valid modes: ${[...VALID_MODES].join(", ")}`); process.exit(1) }
      requireCanvas(); action = { ...base, type: "set_mode", mode: args[1] }; channelName = canvasCh(); break
    }
    case "set-model": {
      if (!args[1]) { console.error("Error: set-model requires model id."); process.exit(1) }
      requireCanvas(); action = { ...base, type: "set_model", model: args[1] }; channelName = canvasCh(); break
    }
    case "select": {
      if (!args[1]) { console.error("Error: select requires nodeId."); process.exit(1) }
      requireCanvas(); action = { ...base, type: "select_node", nodeId: args[1] }; channelName = canvasCh(); break
    }
    case "deselect": {
      requireCanvas(); action = { ...base, type: "deselect" }; channelName = canvasCh(); break
    }

    // -- Canvas channel: submit (triggers the full generation pipeline) --
    case "submit": {
      if (!args[1]) { console.error("Error: submit requires text."); process.exit(1) }
      requireCanvas()
      const { values: imagePaths } = extractFlag(args.slice(2), "--image")
      const files = imagePaths.length > 0 ? await resolveImages(imagePaths, session) : undefined
      action = { ...base, type: "submit", value: args[1], ...(files ? { files } : {}) }
      channelName = canvasCh(); timeout = ORACLE_TIMEOUT_MS; break
    }

    // -- Canvas channel: read / delete --
    case "read": {
      requireCanvas()
      action = args[1] && args[1] !== "--all" ? { ...base, type: "read_node", nodeId: args[1] } : { ...base, type: "read_all_nodes" }
      channelName = canvasCh(); break
    }
    case "delete": {
      if (!args[1]) { console.error("Error: delete requires nodeId."); process.exit(1) }
      requireCanvas(); action = { ...base, type: "delete_node", nodeId: args[1] }; channelName = canvasCh(); break
    }
    case "delete-many": {
      if (args.length < 2) { console.error("Error: delete-many requires nodeIds."); process.exit(1) }
      requireCanvas(); action = { ...base, type: "delete_nodes", nodeIds: args.slice(1) }; channelName = canvasCh(); break
    }

    default: console.error(`Unknown command: ${cmd}`); printUsage(); process.exit(1)
  }

  // Record submit time BEFORE connectAndExecute: the browser awaits full generation
  // before responding, so nodes are created long before the CLI receives the response.
  const preSubmitTime = new Date(Date.now() - 10_000).toISOString()

  const result = await connectAndExecute(session, userId, channelName, action, timeout, botClient)

  // Auto-set activeConvId after successful create_canvas
  if (action.type === "create_canvas" && result.type === "result" && (result.data as any)?.convId) {
    session.activeConvId = (result.data as any).convId
    saveSession(session)
  }

  console.log(JSON.stringify(result, null, 2))

  // --wait: poll database until the generated node is finished
  if (action.type === "submit" && args.some(a => a === "--wait" || a.startsWith("--wait="))) {
    const waitArg = args.find(a => a.startsWith("--wait"))!
    const parsed = waitArg.includes("=") ? parseInt(waitArg.split("=")[1], 10) : 300
    if (waitArg.includes("=") && (!Number.isFinite(parsed) || parsed <= 0)) {
      console.error(`Warning: invalid --wait value "${waitArg.split("=")[1]}", defaulting to 300s`)
    }
    const waitSec = Number.isFinite(parsed) && parsed > 0 ? parsed : 300
    const deadline = Date.now() + waitSec * 1000
    const convId = session.activeConvId! // Already validated by requireCanvas() in submit

    console.error(`Waiting for generation (timeout: ${waitSec}s)...`)

    const submitTime = preSubmitTime
    // Extract questionNodeId from submit response for precise polling
    const questionNodeId = result.type === "result" ? (result.data as any)?.questionNodeId : undefined

    // Poll via browser broadcast
    const pollClient = new RealtimeLite(session.supabaseUrl, session.supabaseKey, session.accessToken)
    await pollClient.connect()
    const ctrlCh = `bot_ctrl:${userId}`
    await pollClient.join(ctrlCh)
    let interval = 2_000
    let pollCount = 0
    try {
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, interval))
        interval = Math.min(interval + Math.floor(interval * 0.5), 10_000)
        pollCount++

        try {
          const pollAction: BotAction = { actionId: crypto.randomUUID(), sessionId: session.sessionId, timestamp: new Date().toISOString(), type: "poll_generation", convId, createdAfter: submitTime, ...(questionNodeId ? { parentId: questionNodeId } : {}) }
          const resp = await sendAndWait(pollClient, ctrlCh, pollAction, ACTION_TIMEOUT_MS)

          if (resp.type === "error") {
            console.error(`  poll #${pollCount} error: ${(resp as any).message}`)
            continue
          }

          const data = (resp as any).data
          const status = data?.status

          if (pollCount === 1 || pollCount % 5 === 0) {
            console.error(`  poll #${pollCount}: status: ${status ?? "none"}`)
          }

          if (status === "finished") {
            console.error("Generation finished.")
            console.log(JSON.stringify({ type: "result", actionId: action.actionId, data: data.node }, null, 2))
            return
          }
          if (status === "failed") {
            if (data.isNoCredits) {
              console.error("No credits remaining.")
              console.log(JSON.stringify({
                type: "error",
                actionId: action.actionId,
                code: "NO_CREDITS",
                message: "It looks like you've run out of credits. Visit /pricing to subscribe and keep creating: https://flowith.io/pricing",
                data: data.node,
              }))
            } else {
              console.error("Generation failed.")
              console.log(JSON.stringify({ type: "error", actionId: action.actionId, code: "GENERATION_FAILED", message: "Generation failed", data: data.node }))
            }
            return
          }
        } catch (e: any) {
          console.error(`  poll #${pollCount} error: ${e.message}`)
        }
      }
    } finally {
      pollClient.close()
    }
    console.error(`Timed out after ${waitSec}s. Use 'read-db' to check node status manually.`)
  }
}

function sendAndWait(client: RealtimeLite, ch: string, action: BotAction, timeout: number): Promise<BotResponse> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { cleanup(); rej(new Error(`Timeout (${timeout / 1000}s). Is Flowith open on the correct canvas?`)) }, timeout)
    const cleanup = client.onBroadcast(ch, BOT_EVENTS.RESPONSE, (r: BotResponse) => { if (r.actionId !== action.actionId || r.type === "ack") return; clearTimeout(t); cleanup(); res(r) })
    client.broadcast(ch, BOT_EVENTS.ACTION, action)
  })
}

function printUsage() {
  console.log(`
Canvas Bot CLI — Remote Flowith canvas control (zero dependencies)

Usage:  bun .claude/skills/canvas/canvas-bot.ts --bot <identity> <command> [args]

Global:
  --bot <identity>                Set bot cursor identity (claude-code|codex|openclaw|cursor|opencode|flowithos)

Commands:
  status                          Check session
  open [convId]                   Open Flowith in browser
  ping                            Test browser connection

  create-canvas [title]           Create new canvas (auto-switches, adds [Bot] prefix)
  switch <convId>                 Set active canvas
  list                            List recent canvases
  search "query"                  Search canvases by title (case-insensitive)
  list-models [mode]              List available models (text|image|video|agent)

  set-mode <mode>                 Set generation mode (text|image|video|agent|neo)
  set-model <model-id>            Set model
  select <nodeId>                 Select node as follow-up target
  deselect                        Clear follow-up target (next submit starts a new branch)
  submit "text" [--image <path-or-url>]... [--wait]
                                    Submit text with optional image(s)
                                    --image: local file (auto-uploaded) or URL
                                    In image mode: used as style reference
                                    In video mode: used as start/end frame
                                    In text mode: multimodal attachment

  read [nodeId | --all]           Read node(s) from browser memory
  delete <nodeId>                 Delete node (via browser)
  delete-many <id1> <id2> ...     Delete multiple nodes (via browser)

  recall ["query"] [flags]         Search user's memory (fast DB match + AI fallback)
                                    --type <text|image|video|webpage>  Filter by content type
                                    --conv <convId>                    Scope to a conversation
                                    --limit <n>                        Max results (default 10)
                                    Empty query with --conv lists all entries on that canvas
  recall-node <convId> <nodeId>   Get bookshelf metadata for a specific node

  read-db [nodeId] [--failed] [--full]  Read nodes from database (default: summary)
                                         nodeId: drill into one node (full content)
                                         --full: all nodes with full content
                                         --failed: only failed nodes
  clean-failed                    Find & delete all failed nodes from database

  dream-init "theme" [--mode m]   Initialize creative journal (default: image)

First run: browser opens automatically, log in to Flowith, done.
Journal stored in ~/.flowith/creative-journal.md — edit it directly.
Session stored in ~/.flowith/bot-session.json, expires in ~1 hour.
`)
}

main().catch(e => {
  const message = e.message || String(e)
  const code = e instanceof BrowserConnectionError ? e.code
    : message.includes("Timeout") ? "TIMEOUT"
    : "UNKNOWN_ERROR"

  // Structured JSON to stdout so the calling agent can parse it
  console.log(JSON.stringify({ type: "error", actionId: null, code, message }))
  process.exit(1)
})
