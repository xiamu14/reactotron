import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type ReactotronServer from "reactotron-core-server"
import type { Command } from "reactotron-core-contract"
import { z } from "zod/v4"
import { promises as fsPromises } from "fs"
import { extname } from "path"

import { MAX_RESPONSE_CHARS, safeSerialize } from "./serialization"

const timeRangeSchema = z.object({
  start: z.string().optional().describe("Inclusive ISO timestamp start, e.g. '2026-04-15T08:00:00.000Z'"),
  end: z.string().optional().describe("Inclusive ISO timestamp end, e.g. '2026-04-15T08:30:00.000Z'"),
}).optional()

const headerFilterSchema = z.object({
  name: z.string().describe("Header name to match, e.g. 'authorization'"),
  value: z.string().optional().describe("Optional header value substring to match"),
})

/** Extract width/height from PNG or JPEG buffer */
function getImageSize(buf: Buffer, ext: string): { width: number; height: number } | null {
  try {
    if (ext === "png" && buf.length > 24) {
      // PNG: width at offset 16, height at offset 20 (big-endian uint32)
      const width = buf.readUInt32BE(16)
      const height = buf.readUInt32BE(20)
      return { width, height }
    }
    if ((ext === "jpg" || ext === "jpeg") && buf.length > 2) {
      // Validate JPEG magic bytes
      if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null
      // JPEG: scan for SOF0 (0xFFC0) or SOF2 (0xFFC2) marker
      let offset = 2
      while (offset < buf.length - 8) {
        if (buf[offset] !== 0xFF) break
        const marker = buf[offset + 1]
        if (marker === 0xC0 || marker === 0xC2) {
          const height = buf.readUInt16BE(offset + 5)
          const width = buf.readUInt16BE(offset + 7)
          return { width, height }
        }
        const segLen = buf.readUInt16BE(offset + 2)
        offset += 2 + segLen
      }
    }
    if (ext === "gif" && buf.length > 10) {
      // GIF: width at offset 6, height at offset 8 (little-endian uint16)
      const width = buf.readUInt16LE(6)
      const height = buf.readUInt16LE(8)
      return { width, height }
    }
  } catch {}
  return null
}

function resolveClientId(
  server: ReactotronServer,
  requestedClientId?: string
): { clientId?: string; error?: string } {
  const connections = server.connections as any[]

  if (connections.length === 0) {
    return { error: "No apps connected to Reactotron." }
  }

  if (connections.length > 1 && !requestedClientId) {
    const apps = connections.map((c) => `${c.name} (${c.platform}): ${c.clientId}`).join(", ")
    return { error: `Multiple apps connected. Specify clientId. Available: ${apps}` }
  }

  return { clientId: requestedClientId || connections[0]?.clientId }
}

function textResult(data: unknown, guidance?: string) {
  return { content: [{ type: "text" as const, text: safeSerialize(data, MAX_RESPONSE_CHARS, guidance) }] }
}

function parseTimeRange(timeRange?: { start?: string; end?: string }):
  | { start?: number; end?: number }
  | { error: string } {
  if (!timeRange) return {}

  const start = timeRange.start ? Date.parse(timeRange.start) : null
  if (timeRange.start && Number.isNaN(start)) {
    return { error: `Invalid timeRange.start: ${timeRange.start}` }
  }

  const end = timeRange.end ? Date.parse(timeRange.end) : null
  if (timeRange.end && Number.isNaN(end)) {
    return { error: `Invalid timeRange.end: ${timeRange.end}` }
  }

  return { start, end }
}

function isWithinTimeRange(
  command: Command,
  timeRange?: { start?: string; end?: string }
): { matches: boolean } | { error: string } {
  const parsed = parseTimeRange(timeRange)
  if ("error" in parsed) return parsed

  const timestamp = new Date(command.date).getTime()
  if (parsed.start != null && timestamp < parsed.start) return { matches: false }
  if (parsed.end != null && timestamp > parsed.end) return { matches: false }
  return { matches: true }
}

function normalizeToken(value: string) {
  return value.trim().replace(/^\[|\]$/g, "")
}

function extractMessageText(message: unknown): string {
  if (typeof message === "string") return message
  if (Array.isArray(message)) {
    return message.map((item) => extractMessageText(item)).join(" ")
  }
  if (message == null) return ""
  try {
    return JSON.stringify(message)
  } catch {
    return String(message)
  }
}

function extractPrefixParts(message: string) {
  let remaining = message.trim()
  const bracketTokens: string[] = []

  while (remaining.startsWith("[")) {
    const match = remaining.match(/^\[([^\]]+)\]\s*/)
    if (!match) break
    bracketTokens.push(match[1])
    remaining = remaining.slice(match[0].length)
  }

  const words = remaining.trim().split(/\s+/).filter(Boolean)
  return {
    prefix: bracketTokens[0] ?? null,
    subprefix: bracketTokens[1] ?? words[0] ?? null,
    remaining,
  }
}

function matchesLogFilters(
  command: Command,
  {
    prefix,
    subprefix,
    keyword,
    timeRange,
  }: {
    prefix: string
    subprefix?: string
    keyword?: string
    timeRange?: { start?: string; end?: string }
  }
) {
  const timeCheck = isWithinTimeRange(command, timeRange)
  if ("error" in timeCheck) return timeCheck
  if (!timeCheck.matches) return { matches: false }

  const messageText = extractMessageText((command.payload as any)?.message)
  const parts = extractPrefixParts(messageText)
  if (!parts.prefix || normalizeToken(parts.prefix).toLowerCase() !== normalizeToken(prefix).toLowerCase()) {
    return { matches: false }
  }

  if (subprefix) {
    const actualSubprefix = parts.subprefix ? normalizeToken(parts.subprefix).toLowerCase() : ""
    const expectedSubprefix = normalizeToken(subprefix).toLowerCase()
    if (actualSubprefix !== expectedSubprefix) {
      return { matches: false }
    }
  }

  if (keyword && !messageText.toLowerCase().includes(keyword.toLowerCase())) {
    return { matches: false }
  }

  return {
    matches: true,
    entry: {
      messageId: command.messageId,
      clientId: command.clientId,
      date: command.date,
      level: (command.payload as any)?.level ?? "debug",
      prefix: parts.prefix,
      subprefix: parts.subprefix,
      message: messageText,
    },
  }
}

function headerMatches(
  command: Command,
  header?: { name: string; value?: string }
) {
  if (!header) return true

  const targetName = header.name.toLowerCase()
  const targetValue = header.value?.toLowerCase()
  const requestHeaders = ((command.payload as any)?.request?.headers ?? {}) as Record<string, string>
  const responseHeaders = ((command.payload as any)?.response?.headers ?? {}) as Record<string, string>
  const merged = [...Object.entries(requestHeaders), ...Object.entries(responseHeaders)]

  return merged.some(([name, value]) => {
    if (name.toLowerCase() !== targetName) return false
    if (!targetValue) return true
    return String(value ?? "").toLowerCase().includes(targetValue)
  })
}

function extractStorageKeys(data: any): string[] {
  if (!data) return []
  if (typeof data.key === "string") return [data.key]
  if (Array.isArray(data.keys)) return data.keys.filter((key): key is string => typeof key === "string")
  if (Array.isArray(data.keyValueArray)) {
    return data.keyValueArray
      .map((entry) => Array.isArray(entry) ? entry[0] : null)
      .filter((key): key is string => typeof key === "string")
  }
  if (Array.isArray(data)) {
    return data
      .map((entry) => Array.isArray(entry) ? entry[0] : null)
      .filter((key): key is string => typeof key === "string")
  }
  return []
}

export function registerTools(
  mcp: McpServer,
  server: ReactotronServer,
  commandBuffer: Command[]
) {
  mcp.registerTool("dispatch_action", {
    description: [
      "Dispatch a Redux action to the connected app.",
      "Requires the Reactotron Redux plugin to be configured in the app.",
      "Example: { type: 'user/setName', payload: { name: 'Alice' } }",
    ].join(" "),
    inputSchema: {
      actionType: z.string().describe("Action type, e.g. 'counter/increment' or 'RESET'"),
      actionPayload: z.any().optional().describe("Optional action payload, e.g. { name: 'Alice' }"),
      clientId: z.string().optional().describe("Target app clientId (required when multiple apps connected). Get from the apps resource."),
    },
  }, async (args) => {
    const { clientId, error } = resolveClientId(server, args.clientId)
    if (error) return textResult({ status: "error", message: error })

    const action = { type: args.actionType, payload: args.actionPayload }
    server.send("state.action.dispatch", { action }, clientId)

    // Poll for confirmation (state.action.complete)
    const start = Date.now()
    const startLen = commandBuffer.length
    while (Date.now() - start < 1500) {
      await new Promise((r) => setTimeout(r, 100))
      for (let i = startLen; i < commandBuffer.length; i++) {
        const cmd = commandBuffer[i]
        if (cmd.type === "state.action.complete" && cmd.clientId === clientId) {
          return textResult({ status: "dispatched", action, confirmed: true })
        }
      }
    }
    return textResult({ status: "dispatched", action, confirmed: false, note: "Action was sent but no confirmation received. The app may not have the Redux plugin configured." })
  })

  mcp.registerTool("request_state", {
    description: [
      "Request a fresh state snapshot from the connected app.",
      "Requires Redux or MST plugin configured in the app.",
      "IMPORTANT: Always specify a path to avoid oversized responses.",
      "The full state tree can be millions of characters.",
      "Use request_state_keys first to explore the state shape, then request specific slices.",
      "Example path: 'user.profile' to get just that slice.",
    ].join(" "),
    inputSchema: {
      path: z.string().optional().describe("Dot-separated state path, e.g. 'user.profile'. STRONGLY RECOMMENDED — omitting this returns the full state tree which may be too large."),
      clientId: z.string().optional().describe("Target app clientId (required when multiple apps connected)."),
    },
  }, async (args) => {
    const { clientId, error } = resolveClientId(server, args.clientId)
    if (error) return textResult({ status: "error", message: error })

    const path = args.path ?? ""
    server.send("state.values.request", { path }, clientId)

    const start = Date.now()
    const startLen = commandBuffer.length
    while (Date.now() - start < 1500) {
      await new Promise((r) => setTimeout(r, 100))
      for (let i = startLen; i < commandBuffer.length; i++) {
        const cmd = commandBuffer[i]
        if (cmd.type === "state.values.response" && cmd.clientId === clientId) {
          return textResult(
            { status: "success", state: cmd.payload?.value ?? cmd.payload },
            "State response is too large. Use request_state with a more specific path (e.g. 'user.profile') to narrow the response. Use request_state_keys to explore the state shape."
          )
        }
      }
    }
    return textResult({ status: "no_response", message: "The app did not respond to the state request. It likely doesn't have a state management plugin (Redux or MST) configured in Reactotron." })
  })

  mcp.registerTool("request_state_keys", {
    description: [
      "List the keys at a state path without fetching values.",
      "Use this to explore the state tree structure before requesting specific slices with request_state.",
      "Returns an array of key names at the given path.",
      "Example: path='' returns root keys, path='user' returns keys under user.",
    ].join(" "),
    inputSchema: {
      path: z.string().optional().describe("Dot-separated state path. Omit or pass empty string for root keys."),
      clientId: z.string().optional().describe("Target app clientId (required when multiple apps connected)."),
    },
  }, async (args) => {
    const { clientId, error } = resolveClientId(server, args.clientId)
    if (error) return textResult({ status: "error", message: error })

    const path = args.path ?? ""
    server.send("state.keys.request", { path }, clientId)

    const start = Date.now()
    const startLen = commandBuffer.length
    while (Date.now() - start < 1500) {
      await new Promise((r) => setTimeout(r, 100))
      for (let i = startLen; i < commandBuffer.length; i++) {
        const cmd = commandBuffer[i]
        if (cmd.type === "state.keys.response" && cmd.clientId === clientId) {
          return textResult({
            status: "success",
            path: (cmd.payload as any)?.path ?? path,
            keys: (cmd.payload as any)?.keys ?? [],
            valid: (cmd.payload as any)?.valid ?? true,
          })
        }
      }
    }
    return textResult({ status: "no_response", message: "The app did not respond to the keys request. It likely doesn't have a state management plugin (Redux or MST) configured in Reactotron." })
  })

  mcp.registerTool("swap_state", {
    description: [
      "Replace the entire app state tree. WARNING: this is destructive and cannot be undone.",
      "Requires the Reactotron state plugin (Redux or MST).",
      "Use request_state first to get the current state, modify it, then swap.",
    ].join(" "),
    inputSchema: {
      state: z.record(z.string(), z.any()).describe("The complete replacement state tree as a JSON object."),
      clientId: z.string().optional().describe("Target app clientId (required when multiple apps connected)."),
    },
  }, async (args) => {
    const { clientId, error } = resolveClientId(server, args.clientId)
    if (error) return textResult({ status: "error", message: error })

    server.send("state.restore.request", { state: args.state }, clientId)
    return textResult({ status: "swapped", message: "State replacement sent to app." })
  })

  mcp.registerTool("send_custom_command", {
    description: [
      "Send a named custom command to the app.",
      "The app must have registered a handler for this command name.",
      "Use list_custom_commands first to see what commands are available.",
      "Example: command='showDebugOverlay', args={ enabled: true }",
    ].join(" "),
    inputSchema: {
      command: z.string().describe("The custom command name, e.g. 'ping' or 'showDebugOverlay'"),
      args: z.any().optional().describe("Optional arguments to pass to the command handler"),
      clientId: z.string().optional().describe("Target app clientId (required when multiple apps connected)."),
    },
  }, async (args) => {
    const { clientId, error } = resolveClientId(server, args.clientId)
    if (error) return textResult({ status: "error", message: error })

    server.send("custom", { command: args.command, args: args.args }, clientId)
    return textResult({ status: "sent", command: args.command })
  })

  mcp.registerTool("list_custom_commands", {
    description: [
      "List all custom commands registered by the connected app.",
      "These are commands the app has set up handlers for.",
      "Use this before send_custom_command to see what's available.",
    ].join(" "),
    inputSchema: {
      clientId: z.string().optional().describe("Target app clientId (required when multiple apps connected)."),
    },
  }, async (args) => {
    const { clientId, error } = resolveClientId(server, args.clientId)
    if (error) return textResult({ status: "error", message: error })

    const commands = (server.customCommands?.get(clientId) ?? []).map((c) => ({
      id: c.id,
      command: c.command,
      title: c.title,
      description: c.description,
    }))

    if (commands.length === 0) {
      return textResult({ status: "none", message: "No custom commands registered by the app." })
    }

    return textResult({ status: "success", commands })
  })

  mcp.registerTool("show_overlay", {
    description: [
      "Show an image overlay on top of the running app.",
      "Useful for comparing a design mockup against the actual UI.",
      "The app must have the overlay plugin enabled (it is by default in React Native).",
      "Pass uri=null or opacity=0 to hide the overlay.",
    ].join(" "),
    inputSchema: {
      uri: z.string().nullable().describe("Image to display. Accepts a local file path (/path/to/image.png), file:// URI, http/https URL, or data: URI. Local files are automatically converted to base64. Pass null to clear the overlay."),
      opacity: z.number().optional().describe("Overlay opacity from 0 to 1 (default: 0.5)"),
      growToWindow: z.boolean().optional().describe("Scale image to fill the entire window (default: false)"),
      resizeMode: z.enum(["cover", "contain", "stretch", "center"]).optional().describe("How to resize the image when growToWindow is true (default: cover)"),
      width: z.number().optional().describe("Image width in pixels (ignored if growToWindow is true)"),
      height: z.number().optional().describe("Image height in pixels (ignored if growToWindow is true)"),
      marginTop: z.number().optional().describe("Top margin offset in pixels"),
      marginBottom: z.number().optional().describe("Bottom margin offset in pixels"),
      marginLeft: z.number().optional().describe("Left margin offset in pixels"),
      marginRight: z.number().optional().describe("Right margin offset in pixels"),
      justifyContent: z.enum(["flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly"]).optional().describe("Vertical alignment of the overlay image (default: center)"),
      alignItems: z.enum(["flex-start", "flex-end", "center", "stretch", "baseline"]).optional().describe("Horizontal alignment of the overlay image (default: center)"),
      showDebug: z.boolean().optional().describe("Show debug info overlay with current overlay settings (useful for positioning)"),
      clientId: z.string().optional().describe("Target app clientId (required when multiple apps connected)."),
    },
  }, async (args) => {
    const { clientId, error } = resolveClientId(server, args.clientId)
    if (error) return textResult({ status: "error", message: error })

    const { clientId: _, ...overlayArgs } = args as any
    const payload: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(overlayArgs)) {
      if (value !== undefined) payload[key] = value
    }

    // Convert local file paths to data: URIs
    if (typeof payload.uri === "string" && !payload.uri.startsWith("data:") && !payload.uri.startsWith("http")) {
      const filePath = (payload.uri as string).replace(/^file:\/\//, "")
      const ext = extname(filePath).slice(1).toLowerCase()
      const supportedFormats: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif" }
      const mime = supportedFormats[ext]
      if (!mime) {
        return textResult({ status: "error", message: `Unsupported image format: .${ext}. Use PNG, JPEG, or GIF.` })
      }
      try {
        const buf = await fsPromises.readFile(filePath)
        const maxSize = 2 * 1024 * 1024 // 2MB file size limit
        if (buf.length > maxSize) {
          return textResult({ status: "error", message: `Image too large (${(buf.length / 1024 / 1024).toFixed(1)}MB). Maximum is 2MB. Resize or compress the image first.` })
        }
        payload.uri = `data:${mime};base64,${buf.toString("base64")}`
        // Extract dimensions if not already specified
        if (!payload.width || !payload.height) {
          const size = getImageSize(buf, ext)
          if (size) {
            payload.width = payload.width ?? size.width
            payload.height = payload.height ?? size.height
          }
        }
      } catch (e) {
        return textResult({ status: "error", message: `Could not read file: ${filePath}` })
      }
    }

    // Apply defaults matching the desktop app's behavior
    payload.opacity = payload.opacity ?? 0.5
    payload.marginTop = payload.marginTop ?? 0
    payload.marginRight = payload.marginRight ?? 0
    payload.marginBottom = payload.marginBottom ?? 0
    payload.marginLeft = payload.marginLeft ?? 0
    payload.growToWindow = payload.growToWindow ?? false
    payload.justifyContent = payload.justifyContent ?? "center"
    payload.alignItems = payload.alignItems ?? "center"

    const uriLen = typeof payload.uri === "string" ? payload.uri.length : 0
    try {
      server.send("overlay", payload, clientId)
    } catch (e) {
      return textResult({ status: "error", message: `Failed to send overlay: ${e}` })
    }
    return textResult({ status: "sent", overlay: { ...payload, uri: uriLen > 0 ? `(${uriLen} chars)` : null } })
  })

  mcp.registerTool("clear_timeline", {
    description: "Clear the MCP event buffer. This only affects what you see via MCP resources — the Reactotron desktop app's timeline is not affected. Useful to discard old events and focus on what happens next.",
    inputSchema: {},
  }, async () => {
    const count = commandBuffer.length
    commandBuffer.length = 0
    return textResult({ status: "cleared", eventsRemoved: count })
  })

  mcp.registerTool("query_logs", {
    description: [
      "Read filtered log events from the current timeline buffer.",
      "A prefix is required to avoid broad log dumps.",
      "You can narrow further with subprefix, keyword, limit, and timeRange.",
      "Returns newest-first.",
    ].join(" "),
    inputSchema: {
      prefix: z.string().describe("Required log prefix without brackets, e.g. 'JPush' or 'PHASE-1'"),
      subprefix: z.string().optional().describe("Optional subprefix, e.g. 'firstFrameRendered'"),
      keyword: z.string().optional().describe("Optional keyword substring to match anywhere in the log message"),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum number of results to return, default 20"),
      timeRange: timeRangeSchema.describe("Optional time range filter"),
      clientId: z.string().optional().describe("Optional app clientId filter"),
    },
  }, async (args) => {
    const limit = args.limit ?? 20
    const relevantCommands = commandBuffer
      .filter((command) => command.type === "log")
      .filter((command) => !args.clientId || command.clientId === args.clientId)

    const matched = []
    for (const command of [...relevantCommands].reverse()) {
      const result = matchesLogFilters(command, {
        prefix: args.prefix,
        subprefix: args.subprefix,
        keyword: args.keyword,
        timeRange: args.timeRange,
      })
      if ("error" in result) {
        return textResult({ status: "error", message: result.error })
      }
      if (result.matches) {
        matched.push(result.entry)
      }
      if (matched.length >= limit) break
    }

    return textResult({
      status: "success",
      filters: {
        prefix: args.prefix,
        subprefix: args.subprefix ?? null,
        keyword: args.keyword ?? null,
        limit,
        timeRange: args.timeRange ?? null,
        clientId: args.clientId ?? null,
      },
      count: matched.length,
      events: matched,
    })
  })

  mcp.registerTool("query_network", {
    description: [
      "Read filtered network entries from the current timeline buffer.",
      "A URL substring is required.",
      "You can narrow further with method, header, limit, and timeRange.",
      "Returns newest-first.",
    ].join(" "),
    inputSchema: {
      url: z.string().describe("Required URL substring to match, e.g. '/api/projects' or 'hugopia.yocdev.com'"),
      method: z.string().optional().describe("Optional HTTP method filter, e.g. 'GET' or 'POST'"),
      header: headerFilterSchema.optional().describe("Optional header filter"),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum number of results to return, default 20"),
      timeRange: timeRangeSchema.describe("Optional time range filter"),
      clientId: z.string().optional().describe("Optional app clientId filter"),
    },
  }, async (args) => {
    const limit = args.limit ?? 20
    const matched = []

    for (const command of [...commandBuffer].reverse()) {
      if (command.type !== "api.response") continue
      if (args.clientId && command.clientId !== args.clientId) continue

      const timeCheck = isWithinTimeRange(command, args.timeRange)
      if ("error" in timeCheck) {
        return textResult({ status: "error", message: timeCheck.error })
      }
      if (!timeCheck.matches) continue

      const payload = command.payload as any
      const requestUrl = String(payload?.request?.url ?? "")
      if (!requestUrl.toLowerCase().includes(args.url.toLowerCase())) continue

      if (args.method && String(payload?.request?.method ?? "").toLowerCase() !== args.method.toLowerCase()) {
        continue
      }

      if (!headerMatches(command, args.header)) continue

      matched.push({
        messageId: command.messageId,
        clientId: command.clientId,
        date: command.date,
        duration: payload?.duration,
        request: payload?.request,
        response: payload?.response,
      })

      if (matched.length >= limit) break
    }

    return textResult({
      status: "success",
      filters: {
        url: args.url,
        method: args.method ?? null,
        header: args.header ?? null,
        limit,
        timeRange: args.timeRange ?? null,
        clientId: args.clientId ?? null,
      },
      count: matched.length,
      entries: matched,
    }, "Network results are too large. Narrow further with a more specific URL, header, or smaller time range.")
  })

  mcp.registerTool("query_storage", {
    description: [
      "Read filtered AsyncStorage mutation events from the current timeline buffer.",
      "A storage key is required.",
      "You can narrow with limit and timeRange.",
      "Returns newest-first.",
    ].join(" "),
    inputSchema: {
      key: z.string().describe("Required storage key to match exactly"),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum number of results to return, default 20"),
      timeRange: timeRangeSchema.describe("Optional time range filter"),
      clientId: z.string().optional().describe("Optional app clientId filter"),
    },
  }, async (args) => {
    const limit = args.limit ?? 20
    const matched = []

    for (const command of [...commandBuffer].reverse()) {
      if (command.type !== "asyncStorage.mutation") continue
      if (args.clientId && command.clientId !== args.clientId) continue

      const timeCheck = isWithinTimeRange(command, args.timeRange)
      if ("error" in timeCheck) {
        return textResult({ status: "error", message: timeCheck.error })
      }
      if (!timeCheck.matches) continue

      const payload = command.payload as any
      const keys = extractStorageKeys(payload?.data)
      if (!keys.includes(args.key)) continue

      matched.push({
        messageId: command.messageId,
        clientId: command.clientId,
        date: command.date,
        action: payload?.action,
        key: args.key,
        data: payload?.data,
      })

      if (matched.length >= limit) break
    }

    return textResult({
      status: "success",
      filters: {
        key: args.key,
        limit,
        timeRange: args.timeRange ?? null,
        clientId: args.clientId ?? null,
      },
      count: matched.length,
      mutations: matched,
    }, "Storage results are too large. Narrow the time range or lower the limit.")
  })

  mcp.registerTool("subscribe_state", {
    description: [
      "Subscribe to a state path. The app will send state.values.change events whenever the value at this path changes.",
      "Read the state/subscriptions resource to see changes.",
      "Requires Redux or MST plugin. Example path: 'user.profile.name'",
    ].join(" "),
    inputSchema: {
      path: z.string().describe("Dot-separated state path to subscribe to, e.g. 'user.profile' or 'cart.items'"),
    },
  }, async (args) => {
    const path = args.path
    if (!path) return textResult({ status: "error", message: "path is required" })

    ;(server as any).stateValuesSubscribe(path)
    const active = (server as any).subscriptions || []
    return textResult({ status: "subscribed", path, activeSubscriptions: active })
  })

  mcp.registerTool("unsubscribe_state", {
    description: "Unsubscribe from a state path. Stops receiving change events for this path.",
    inputSchema: {
      path: z.string().describe("State path to unsubscribe from"),
    },
  }, async (args) => {
    const path = args.path
    if (!path) return textResult({ status: "error", message: "path is required" })

    ;(server as any).stateValuesUnsubscribe(path)
    const active = (server as any).subscriptions || []
    return textResult({ status: "unsubscribed", path, activeSubscriptions: active })
  })
}
