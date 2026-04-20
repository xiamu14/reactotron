import { createServer as createHttpServer, type Server as HttpServer } from "http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type ReactotronServer from "reactotron-core-server"
import type { Command } from "reactotron-core-contract"

import { registerResources } from "./resources"
import { registerTools } from "./tools"

export interface ReactotronMcpServer {
  start(port?: number): Promise<void>
  stop(): void
  readonly started: boolean
  readonly port: number | null
}

interface CreateMcpServerOptions {
  clearTimeline?: (clientId?: string) => void
  getCommands?: () => Command[]
}

export function createMcpServer(
  reactotronServer: ReactotronServer,
  options: CreateMcpServerOptions = {}
): ReactotronMcpServer {
  let httpServer: HttpServer | null = null
  let started = false
  let listenPort: number | null = null
  const knownApps = new Map<string, {
    id: number
    clientId: string
    name: string
    platform: string
    platformVersion?: string
    connected: boolean
    lastSeenAt?: string
  }>()

  // Command buffer — collects recent commands for resource reads
  const commandBuffer: Command[] = []
  const BUFFER_SIZE = 500
  let commandListener: ((command: Command) => void) | null = null
  let connectionEstablishedListener: ((connection: any) => void) | null = null
  let disconnectListener: ((connection: any) => void) | null = null

  function snapshotApps() {
    const liveApps = (reactotronServer.connections as any[]).map((connection) => ({
      id: connection.id,
      clientId: connection.clientId,
      name: connection.name,
      platform: connection.platform,
      platformVersion: connection.platformVersion,
      connected: true,
      lastSeenAt: new Date().toISOString(),
    }))

    liveApps.forEach((app) => {
      knownApps.set(app.clientId, app)
    })

    console.log("[reactotron-mcp] snapshotApps", JSON.stringify({
      liveCount: liveApps.length,
      liveApps: liveApps.map((app) => ({
        name: app.name,
        clientId: app.clientId,
        connected: app.connected,
      })),
      knownCount: knownApps.size,
      knownApps: Array.from(knownApps.values()).map((app) => ({
        name: app.name,
        clientId: app.clientId,
        connected: app.connected,
      })),
    }))

    return liveApps.length > 0 ? liveApps : Array.from(knownApps.values())
  }

  function startBuffering() {
    commandListener = (command: Command) => {
      commandBuffer.push(command)
      if (commandBuffer.length > BUFFER_SIZE) {
        commandBuffer.shift()
      }
    }
    reactotronServer.on("command", commandListener as any)

    connectionEstablishedListener = (connection: any) => {
      console.log("[reactotron-mcp] connectionEstablished", JSON.stringify({
        name: connection.name,
        clientId: connection.clientId,
        platform: connection.platform,
      }))
      knownApps.set(connection.clientId, {
        id: connection.id,
        clientId: connection.clientId,
        name: connection.name,
        platform: connection.platform,
        platformVersion: connection.platformVersion,
        connected: true,
        lastSeenAt: new Date().toISOString(),
      })
    }
    reactotronServer.on("connectionEstablished", connectionEstablishedListener as any)

    disconnectListener = (connection: any) => {
      console.log("[reactotron-mcp] disconnect", JSON.stringify({
        name: connection.name,
        clientId: connection.clientId,
        platform: connection.platform,
      }))
      const previous = knownApps.get(connection.clientId)
      knownApps.set(connection.clientId, {
        ...previous,
        id: connection.id,
        clientId: connection.clientId,
        name: connection.name,
        platform: connection.platform,
        platformVersion: connection.platformVersion,
        connected: false,
        lastSeenAt: new Date().toISOString(),
      })
    }
    reactotronServer.on("disconnect", disconnectListener as any)
  }

  function stopBuffering() {
    if (commandListener) {
      reactotronServer.off("command", commandListener as any)
      commandListener = null
    }
    if (connectionEstablishedListener) {
      reactotronServer.off("connectionEstablished", connectionEstablishedListener as any)
      connectionEstablishedListener = null
    }
    if (disconnectListener) {
      reactotronServer.off("disconnect", disconnectListener as any)
      disconnectListener = null
    }
    commandBuffer.length = 0
    knownApps.clear()
  }

  /** Create a fresh McpServer instance with all resources/tools registered */
  function createMcp(): McpServer {
    const mcp = new McpServer(
      { name: "reactotron", version: "0.1.0" },
      { capabilities: { resources: {}, tools: {} } }
    )
    registerResources(mcp, reactotronServer, commandBuffer, options.getCommands, snapshotApps)
    registerTools(mcp, reactotronServer, commandBuffer, options)
    return mcp
  }

  function ensureAcceptHeader(req: import("http").IncomingMessage) {
    const acceptHeader = req.headers.accept ?? ""
    const acceptsJson = acceptHeader.includes("application/json")
    const acceptsEventStream = acceptHeader.includes("text/event-stream")

    if (acceptsJson && acceptsEventStream) {
      return
    }

    const normalizedAccept = "application/json, text/event-stream"
    req.headers.accept = normalizedAccept

    const rawHeaders = [...(req.rawHeaders ?? [])]
    let replaced = false

    for (let i = 0; i < rawHeaders.length; i += 2) {
      if (rawHeaders[i]?.toLowerCase() === "accept") {
        rawHeaders[i + 1] = normalizedAccept
        replaced = true
      }
    }

    if (!replaced) {
      rawHeaders.push("Accept", normalizedAccept)
    }

    req.rawHeaders = rawHeaders
  }

  return {
    get started() { return started },
    get port() { return listenPort },

    start(port = 4567) {
      if (started) return Promise.resolve()

      started = true
      listenPort = port

      startBuffering()

      httpServer = createHttpServer(async (req, res) => {
        if (req.method === "OPTIONS") {
          res.writeHead(204)
          res.end()
          return
        }

        const url = new URL(req.url ?? "/", `http://${req.headers.host}`)

        if (url.pathname === "/mcp" && req.method === "POST") {
          ensureAcceptHeader(req)

          console.log("[reactotron-mcp] request", JSON.stringify({
            path: url.pathname,
            method: req.method,
            liveConnections: (reactotronServer.connections as any[]).map((connection) => ({
              name: connection.name,
              clientId: connection.clientId,
            })),
            commandBufferSize: commandBuffer.length,
          }))
          // Stateless: new server + transport per request
          const mcp = createMcp()
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          })

          try {
            await mcp.connect(transport)
            await transport.handleRequest(req, res)

            res.on("close", () => {
              transport.close()
              mcp.close()
            })
          } catch (err) {
            console.error("[reactotron-mcp] request handler error:", err)
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" })
              res.end(JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32603, message: String(err) },
                id: null,
              }))
            }
          }
        } else if (url.pathname === "/mcp") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed." },
            id: null,
          }))
        } else {
          res.writeHead(404)
          res.end("Not found")
        }
      })

      return new Promise<void>((resolve, reject) => {
        httpServer!.on("error", (err) => {
          started = false
          listenPort = null
          reject(err)
        })

        httpServer!.listen(port, "127.0.0.1", () => {
          resolve()
        })
      })
    },

    stop() {
      if (!started) return

      stopBuffering()

      if (httpServer) {
        httpServer.close()
        httpServer = null
      }

      started = false
      listenPort = null
    },
  }
}
