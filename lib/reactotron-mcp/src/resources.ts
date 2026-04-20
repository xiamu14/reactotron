import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import type ReactotronServer from "reactotron-core-server"
import type { Command } from "reactotron-core-contract"

import {
  MAX_RESPONSE_CHARS,
  safeSerialize,
  summarizeCommand,
} from "./serialization"

interface AppInfo {
  id: number
  clientId: string
  name: string
  platform: string
  platformVersion?: string
  connected?: boolean
  lastSeenAt?: string
}

type GetApps = () => AppInfo[]

function connectionMeta(apps: AppInfo[]): Record<string, unknown> {
  const connectedApps = apps.filter((app) => app.connected !== false)

  if (connectedApps.length === 0 && apps.length === 0) {
    return {
      connection: "no_apps_connected",
      hint: "No apps are connected to Reactotron. Start your React Native / React app with Reactotron configured.",
    }
  }

  if (connectedApps.length === 0) {
    if (apps.length === 1) {
      return {
        connection: "recent_app_disconnected",
        app: apps[0],
        hint: `Recently captured events from ${apps[0].name} (${apps[0].platform}), but it is not connected right now.`,
      }
    }

    return {
      connection: "recent_apps_disconnected",
      apps,
      hint: "Recently captured events from these apps, but none of them are connected right now.",
    }
  }

  if (connectedApps.length === 1) {
    return {
      connection: "single_app",
      app: connectedApps[0],
      hint: `Connected to ${connectedApps[0].name} (${connectedApps[0].platform}). All data is from this app.`,
    }
  }

  return {
    connection: "multiple_apps",
    apps: connectedApps,
    hint: "Multiple apps are connected. If the user hasn't specified which app, ask them. Then pass clientId to filter data. Check the workspace's package.json name to see if it matches one of these app names.",
  }
}

function filterByClient(
  commands: Command[],
  apps: AppInfo[],
  clientId?: string
): Command[] {
  if (clientId) {
    return commands.filter((c) => c.clientId === clientId)
  }

  if (apps.length === 1) {
    return commands.filter((c) => c.clientId === apps[0].clientId)
  }

  return commands
}

function json(uri: URL, data: unknown, guidance?: string) {
  return {
    contents: [{
      uri: uri.href,
      mimeType: "application/json" as const,
      text: safeSerialize(data, MAX_RESPONSE_CHARS, guidance),
    }],
  }
}

function filteredQueryGuidance(type: string) {
  switch (type) {
    case "log":
      return {
        status: "filtered_query_required",
        type,
        message: "Log reads must use the query_logs tool with a required prefix. You can optionally add subprefix, keyword, excludeKeyword, limit, and timeRange.",
        tool: "query_logs",
        required: ["prefix"],
        optional: ["subprefix", "keyword", "excludeKeyword", "limit", "timeRange", "clientId"],
      }
    case "api.response":
      return {
        status: "filtered_query_required",
        type,
        message: "Network reads must use the query_network tool with a required url filter. You can optionally add method, header, limit, and timeRange.",
        tool: "query_network",
        required: ["url"],
        optional: ["method", "header", "limit", "timeRange", "clientId"],
      }
    case "asyncStorage.mutation":
      return {
        status: "filtered_query_required",
        type,
        message: "Storage reads must use the query_storage tool with a required key filter. You can optionally add limit and timeRange.",
        tool: "query_storage",
        required: ["key"],
        optional: ["limit", "timeRange", "clientId"],
      }
    default:
      return null
  }
}

export function registerResources(
  mcp: McpServer,
  server: ReactotronServer,
  commandBuffer: Command[],
  getCommands: (() => Command[]) | undefined,
  getApps: GetApps = () =>
    (server.connections as any[]).map((c) => ({
      id: c.id,
      clientId: c.clientId,
      name: c.name,
      platform: c.platform,
      platformVersion: c.platformVersion,
      connected: true,
    }))
) {
  const currentCommands = () => getCommands?.() ?? commandBuffer

  mcp.registerResource("timeline", "reactotron://timeline", {
    description: "Read this first to understand what's happening in the app. Returns summarized debug events (type, timestamp, and a short preview) newest-first. Payloads are stripped to keep the response small. For logs, network, and storage details, use the filtered query_logs, query_network, and query_storage tools instead of broad timeline reads.",
    mimeType: "application/json",
  }, async (uri) => {
    const apps = getApps()
    const meta = connectionMeta(apps)
    const events = filterByClient(currentCommands(), apps)
    const summarized = [...events].reverse().map(summarizeCommand)
    return json(uri, { _meta: meta, eventCount: events.length, events: summarized },
      "Events are summarized. Use timeline_by_type only for non-log event types. For logs, network, and storage, use query_logs, query_network, or query_storage with explicit filters.")
  })

  mcp.registerResource("timeline_by_type",
    new ResourceTemplate("reactotron://timeline/{type}", {
      list: async () => {
        const types = [...new Set(currentCommands().map((c) => c.type))]
        return {
          resources: types.map((t) => ({
            uri: `reactotron://timeline/${t}`,
            name: `timeline:${t}`,
          })),
        }
      },
      complete: {
        type: async (value) => {
          const types = [...new Set(currentCommands().map((c) => c.type))]
          return types.filter((t) => t.startsWith(value))
        },
      },
    }),
    {
      description: "Timeline events filtered by command type, with full payloads for non-log event types. For log, api.response, and asyncStorage.mutation, use the dedicated filtered tools instead.",
      mimeType: "application/json",
    },
    async (uri, { type }) => {
      const apps = getApps()
      const meta = connectionMeta(apps)
      const resolvedType = Array.isArray(type) ? type[0] : type
      const filteredGuidance = filteredQueryGuidance(resolvedType)
      if (filteredGuidance) {
        return json(uri, { _meta: meta, ...filteredGuidance })
      }
      const events = filterByClient(currentCommands(), apps)
        .filter((c) => c.type === resolvedType)
      return json(uri, { _meta: meta, type: resolvedType, eventCount: events.length, events: [...events].reverse() },
        `Too many ${resolvedType} events to return in full. Try clear_timeline to reset, then reproduce the issue to capture fewer events.`)
    }
  )

  mcp.registerResource("state", "reactotron://state/current", {
    description: "Latest cached Redux/MST state snapshot. May be stale — use the request_state tool for a fresh snapshot. Returns no_state_received if the app hasn't sent state yet.",
    mimeType: "application/json",
  }, async (uri) => {
    const apps = getApps()
    const meta = connectionMeta(apps)
    const stateCommands = filterByClient(
      currentCommands().filter((c) => c.type === "state.values.response"),
      apps
    )
    const latest = stateCommands[stateCommands.length - 1]
    return json(uri, {
      _meta: meta,
      state: latest?.payload?.value ?? {
        status: "no_state_received",
        message: "No state snapshot received yet. Use the request_state tool to request one.",
      },
    }, "State is too large. Use the request_state tool with a path like 'user.profile' to fetch a specific slice. Use request_state_keys to explore the state shape first.")
  })

  mcp.registerResource("network", "reactotron://network/log", {
    description: "Network inspection now requires query_network with an explicit url filter. This resource only points callers to the filtered tool.",
    mimeType: "application/json",
  }, async (uri) => {
    const apps = getApps()
    const meta = connectionMeta(apps)
    return json(uri, { _meta: meta, ...filteredQueryGuidance("api.response") })
  })

  mcp.registerResource("apps", "reactotron://apps", {
    description: "Apps currently connected to Reactotron with their clientId, name, platform, and version. Read this to find the clientId needed for multi-app filtering.",
    mimeType: "application/json",
  }, async (uri) => {
    const apps = getApps()
    const meta = connectionMeta(apps)
    return json(uri, { _meta: meta, apps })
  })

  mcp.registerResource("benchmarks", "reactotron://benchmarks", {
    description: "Performance benchmark results from connected apps, sorted by time. Each has title, steps, and durations.",
    mimeType: "application/json",
  }, async (uri) => {
    const apps = getApps()
    const meta = connectionMeta(apps)
    const benchmarks = filterByClient(
      currentCommands().filter((c) => c.type === "benchmark.report"),
      apps
    )
    return json(uri, {
      _meta: meta,
      benchmarks: benchmarks.map((c) => ({
        date: c.date,
        clientId: c.clientId,
        ...c.payload,
      })),
    })
  })

  mcp.registerResource("subscriptions", "reactotron://state/subscriptions", {
    description: "State subscription changes. Shows values at subscribed paths whenever they change. Use the subscribe_state tool to add subscriptions.",
    mimeType: "application/json",
  }, async (uri) => {
    const apps = getApps()
    const meta = connectionMeta(apps)
    const changes = filterByClient(
      currentCommands().filter((c) => c.type === "state.values.change"),
      apps
    )
    return json(uri, {
      _meta: meta,
      activeSubscriptions: (server as any).subscriptions || [],
      changes: changes.map((c) => ({
        date: c.date,
        clientId: c.clientId,
        ...c.payload,
      })),
    }, "Subscription changes are too large. Consider unsubscribing from paths with large values, or use request_state with a specific path instead.")
  })

  mcp.registerResource("asyncstorage", "reactotron://asyncstorage", {
    description: "Storage inspection now requires query_storage with an explicit key filter. This resource only points callers to the filtered tool.",
    mimeType: "application/json",
  }, async (uri) => {
    const apps = getApps()
    const meta = connectionMeta(apps)
    return json(uri, { _meta: meta, ...filteredQueryGuidance("asyncStorage.mutation") })
  })
}
