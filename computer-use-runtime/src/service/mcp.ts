import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { RuntimeClient } from "../sdk/index.js";
const client = new RuntimeClient(
  process.env.CUR_URL || "http://127.0.0.1:4317",
  readFileSync(
    process.env.CUR_TOKEN_FILE || ".data/service.token",
    "utf8",
  ).trim(),
);
const tools = [
  {
    name: "runtime_capabilities",
    description:
      "Discover the authorized local runtime target and capabilities",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "runtime_submit",
    description:
      "Submit an explicit version 1 task contract through the same service handler",
    inputSchema: {
      type: "object",
      properties: { contract: { type: "object" } },
      required: ["contract"],
      additionalProperties: false,
    },
  },
  {
    name: "runtime_status",
    description: "Read a run status and evidence",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "runtime_control",
    description: "Pause, resume, cancel or reconcile a run",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        command: { enum: ["pause", "resume", "cancel", "reconcile"] },
      },
      required: ["runId", "command"],
      additionalProperties: false,
    },
  },
];
const server = new Server(
  { name: "computer-use-runtime", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = req.params.arguments as any;
  let result: any;
  switch (req.params.name) {
    case "runtime_capabilities":
      result = await client.request("/api/capabilities");
      break;
    case "runtime_submit":
      result = await client.submit(a.contract);
      break;
    case "runtime_status":
      result = {
        run: await client.status(a.runId),
        evidence: await client.request(
          "/api/tasks/" + encodeURIComponent(a.runId) + "/evidence",
        ),
      };
      break;
    case "runtime_control":
      result = await client.control(a.runId, a.command);
      break;
    default:
      throw new Error("Unknown tool");
  }
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});
await server.connect(new StdioServerTransport());
