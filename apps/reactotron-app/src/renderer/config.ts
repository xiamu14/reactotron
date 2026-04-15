import Store from "electron-store"

type StoreType = {
  serverPort: number
  commandHistory: number
  mcpPort: number
}

function resolvePort(value: string | undefined, fallback: number) {
  const port = Number.parseInt(value || "", 10)
  return Number.isInteger(port) && port > 0 ? port : fallback
}

const DEFAULT_SERVER_PORT = resolvePort(process.env.REACTOTRON_SERVER_PORT, 9090)
const DEFAULT_MCP_PORT = resolvePort(process.env.REACTOTRON_MCP_PORT, 4567)

const config = new Store<StoreType>({
  schema: {
    serverPort: {
      type: "number",
      default: DEFAULT_SERVER_PORT,
    },
    commandHistory: {
      type: "number",
      default: 500,
    },
    mcpPort: {
      type: "number",
      default: DEFAULT_MCP_PORT,
    },
  },
})

// Setup defaults
if (!config.has("serverPort")) {
  config.set("serverPort", DEFAULT_SERVER_PORT)
}
if (!config.has("commandHistory")) {
  config.set("commandHistory", 500)
}
if (!config.has("mcpPort")) {
  config.set("mcpPort", DEFAULT_MCP_PORT)
}

if (process.env.REACTOTRON_SERVER_PORT) {
  config.set("serverPort", DEFAULT_SERVER_PORT)
}

if (process.env.REACTOTRON_MCP_PORT) {
  config.set("mcpPort", DEFAULT_MCP_PORT)
}

export default config
