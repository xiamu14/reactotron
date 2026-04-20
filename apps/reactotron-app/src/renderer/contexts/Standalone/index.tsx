import React, { useRef, useEffect, useCallback, useState } from "react"
import Server, { createServer } from "reactotron-core-server"
import type { Command } from "reactotron-core-contract"
import { createMcpServer, type ReactotronMcpServer } from "reactotron-mcp"

import ReactotronBrain from "../../ReactotronBrain"
import config from "../../config"

import useStandalone, { Connection, ServerStatus } from "./useStandalone"

export type McpStatus = "stopped" | "started" | "error"

// TODO: Move up to better places like core somewhere!
interface Context {
  serverStatus: ServerStatus
  connections: Connection[]
  selectedConnection: Connection
  selectConnection: (clientId: string) => void
  mcpStatus: McpStatus
  mcpPort: number | null
  toggleMcp: () => void
}

const StandaloneContext = React.createContext<Context>({
  serverStatus: "stopped",
  connections: [],
  selectedConnection: null,
  selectConnection: null,
  mcpStatus: "stopped",
  mcpPort: null,
  toggleMcp: () => {},
})

const Provider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const reactotronServer = useRef<Server>(null)

  const {
    serverStatus,
    connections,
    selectedClientId,
    selectedConnection,
    selectConnection,
    clearSelectedConnectionCommands,
    clearAllConnectionCommands,
    serverStarted,
    serverStopped,
    connectionEstablished,
    commandReceived,
    connectionDisconnected,
    addCommandListener,
    portUnavailable,
  } = useStandalone()

  useEffect(() => {
    reactotronServer.current = createServer({ port: config.get("serverPort") as number })

    reactotronServer.current.on("start", serverStarted)
    reactotronServer.current.on("stop", serverStopped)
    // @ts-expect-error need to sync these types between reactotron-core-server and reactotron-app
    reactotronServer.current.on("connectionEstablished", connectionEstablished)
    reactotronServer.current.on("command", commandReceived)
    // @ts-expect-error need to sync these types between reactotron-core-server and reactotron-app
    reactotronServer.current.on("disconnect", connectionDisconnected)
    reactotronServer.current.on("portUnavailable", portUnavailable)

    reactotronServer.current.start()

    return () => {
      reactotronServer.current.stop()
    }
  }, [
    serverStarted,
    serverStopped,
    connectionEstablished,
    commandReceived,
    connectionDisconnected,
    portUnavailable,
  ])

  const mcpServerRef = useRef<ReactotronMcpServer>(null)
  const [mcpStatus, setMcpStatus] = useState<McpStatus>("stopped")
  const [mcpPort, setMcpPort] = useState<number | null>(null)
  const connectionsRef = useRef(connections)

  useEffect(() => {
    connectionsRef.current = connections
  }, [connections])

  // Clean up MCP server on unmount
  useEffect(() => {
    return () => {
      if (mcpServerRef.current) {
        mcpServerRef.current.stop()
        mcpServerRef.current = null
      }
    }
  }, [])

  const stopMcp = useCallback(() => {
    if (mcpServerRef.current) {
      mcpServerRef.current.stop()
      mcpServerRef.current = null
    }
    setMcpStatus("stopped")
    setMcpPort(null)
  }, [])

  const startMcp = useCallback(() => {
    if (!reactotronServer.current) return Promise.resolve()

    const port = config.get("mcpPort") as number
    const mcp = createMcpServer(reactotronServer.current, {
      clearTimeline: (clientId?: string) => {
        if (clientId) {
          clearSelectedConnectionCommands(clientId)
          return
        }
        clearAllConnectionCommands()
      },
      getCommands: () =>
        connectionsRef.current
          .flatMap((connection) => connection.commands as Command[])
          .slice()
          .sort((left, right) => {
            const leftMessageId = typeof left?.messageId === "number" ? left.messageId : -1
            const rightMessageId = typeof right?.messageId === "number" ? right.messageId : -1

            if (leftMessageId !== rightMessageId) {
              return leftMessageId - rightMessageId
            }

            return new Date(left.date).getTime() - new Date(right.date).getTime()
          }),
    })

    return mcp.start(port).then(() => {
      mcpServerRef.current = mcp
      setMcpStatus("started")
      setMcpPort(port)
    }).catch(() => {
      setMcpStatus("error")
      setMcpPort(null)
    })
  }, [clearAllConnectionCommands, clearSelectedConnectionCommands])

  const toggleMcp = useCallback(() => {
    if (mcpStatus === "started") {
      stopMcp()
      return
    }

    void startMcp()
  }, [mcpStatus, startMcp, stopMcp])

  useEffect(() => {
    if (process.env.REACTOTRON_AUTO_START_MCP !== "1") {
      return
    }

    if (mcpStatus !== "stopped") {
      return
    }

    void startMcp()
  }, [mcpStatus, startMcp])

  const sendCommand = useCallback(
    (type: string, payload: any, clientId?: string) => {
      // TODO: Do better then just throwing these away...
      if (!reactotronServer.current) return

      reactotronServer.current.send(type, payload, clientId || selectedClientId)
    },
    [reactotronServer, selectedClientId]
  )

  return (
    <StandaloneContext.Provider
      value={{
        serverStatus,
        connections,
        selectedConnection,
        selectConnection,
        mcpStatus,
        mcpPort,
        toggleMcp,
      }}
    >
      <ReactotronBrain
        commands={(selectedConnection || { commands: [] }).commands}
        sendCommand={sendCommand}
        clearCommands={clearSelectedConnectionCommands}
        addCommandListener={addCommandListener}
      >
        {children}
      </ReactotronBrain>
    </StandaloneContext.Provider>
  )
}

export default StandaloneContext
export const StandaloneProvider = Provider
