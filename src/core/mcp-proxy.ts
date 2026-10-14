/** A stdio MCP proxy for ACP HTTP and literal OMP configuration.
 * The private file is a launch snapshot; secrets never enter argv or stdout.
 */
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";

const remote = new Client({ name: "agentbox-mcp-proxy", version: "1" });
try {
  const config = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
  const transport = config.transport === "stdio"
    ? new StdioClientTransport({ command: config.command, args: config.args, env: { ...process.env, ...config.env } as Record<string, string>, cwd: config.cwd, stderr: "inherit" })
    : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
  await remote.connect(transport);
  const local = new Server(remote.getServerVersion() ?? { name: "agentbox-mcp-proxy", version: "1" }, { capabilities: remote.getServerCapabilities(), instructions: remote.getInstructions() });
  local.fallbackRequestHandler = (request, extra) => remote.request(request, ResultSchema, { signal: extra.signal });
  remote.fallbackNotificationHandler = (notification) => local.notification(notification);
  local.fallbackNotificationHandler = (notification) => remote.notification(notification);
  local.onclose = () => { void remote.close(); };
  await local.connect(new StdioServerTransport());
} catch {
  // Transport errors can contain credential-bearing URLs or headers.
  console.error("agentbox: MCP connection failed; check the server URL and credentials in MCPs");
  await remote.close().catch(() => {});
  process.exitCode = 1;
}
