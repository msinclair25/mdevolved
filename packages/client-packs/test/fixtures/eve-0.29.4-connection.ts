import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

const owdMcpUrl = "https://private-deployment.example/mcp";

export default defineMcpClientConnection({
  url: owdMcpUrl,
  description:
    "OWD owner-approved Obsidian knowledge and durable cross-agent Projects. Use it to connect, resume, read bounded context, and exchange cited handoffs.",
  auth: connect({
    connector: "oauth/owd",
    principalType: "user",
    tokenParams: {
      scopes: [
        "vault.read",
        "project.initialize.request",
        "project.connect.request",
      ],
      resources: [owdMcpUrl],
    },
    autoProvision: true,
    displayName: "OWD",
    instructions:
      "Open OWD, verify this eve agent and the exact vault and folder boundary, then approve to continue.",
  }),
});
