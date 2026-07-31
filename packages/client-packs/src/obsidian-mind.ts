export type OwdVaultRuntimeCompatibilityProfile = {
  detection: {
    file: string;
    property: string;
    value: string;
  };
  format: "owd-vault-runtime-profile-v1";
  id: string;
  identity: {
    localRoutingMarker: string;
    rule: string;
    serverProjectReceipt: string;
  };
  mcpTopology: {
    localKnowledgeServer: {
      preferredName: string;
      purpose: string;
      transport: "stdio";
    };
    remoteCollaborationServer: {
      preferredName: string;
      purpose: string;
      transport: "streamable-http";
    };
    rule: string;
  };
  projectDefaults: {
    documentationDecision: "keep-current-locations";
    dynamicContentRoots: readonly string[];
    infrastructurePatterns: readonly string[];
    memoryRoot: string;
    neverOrdinaryContext: readonly string[];
    staticContentRoots: readonly string[];
  };
  source: {
    commit: string;
    license: "MIT";
    repository: string;
    reviewedAt: string;
    version: string;
  };
  toolPolicy: {
    localReadTools: readonly string[];
    localWriteTools: readonly string[];
    rule: string;
  };
};

export const OBSIDIAN_MIND_PROFILE_RESOURCE_URI =
  "owd://compatibility-profiles/obsidian-mind/v1";

/**
 * This profile contains conventions only. It never changes MCP framing,
 * authorization, tool schemas, or OWD's server-side Project authority.
 */
export const OBSIDIAN_MIND_COMPATIBILITY_PROFILE = {
  detection: {
    file: "vault-manifest.json",
    property: "template",
    value: "obsidian-mind",
  },
  format: "owd-vault-runtime-profile-v1",
  id: "obsidian-mind",
  identity: {
    localRoutingMarker: ".om-project",
    rule: "Use .om-project only for Obsidian Mind memory routing. Use the UUID in .owdignore for OWD authorization, resume, and Project identity. In a fresh session, resume first and treat the writer role as unconfirmed until OWD returns localVaultAccess.",
    serverProjectReceipt: ".owdignore",
  },
  mcpTopology: {
    localKnowledgeServer: {
      preferredName: "om",
      purpose:
        "Local graph search, scoped memory recall, reasoning, and owner-authorized vault capture.",
      transport: "stdio",
    },
    remoteCollaborationServer: {
      preferredName: "md-evolved",
      purpose:
        "OAuth-bound remote vault reading, durable Project identity, owner approvals, provenance, and multi-agent coordination.",
      transport: "streamable-http",
    },
    rule: "Run Obsidian Mind and OWD side by side. Never proxy one through the other and never replace the existing qmd or om entry when adding OWD.",
  },
  projectDefaults: {
    documentationDecision: "keep-current-locations",
    dynamicContentRoots: ["perf/h*-*/"],
    infrastructurePatterns: [
      "CLAUDE.md",
      "AGENTS.md",
      "GEMINI.md",
      "Home.md",
      "README.md",
      "README.*.md",
      "CHANGELOG.md",
      "CONTRIBUTING.md",
      "ARCHITECTURE.md",
      "LICENSE",
      ".mcp.json",
      ".claude/**",
      ".claude-plugin/**",
      ".codex/**",
      ".gemini/**",
      "templates/**",
      "bases/**",
      ".scripts/**",
      "vault-manifest.json",
      "brain/Skills.md",
      ".shardmind/**",
      ".shardmindignore",
    ],
    memoryRoot: "memories",
    neverOrdinaryContext: [
      "memories/**",
      "frontmatter private: true",
      "frontmatter tag private",
      "every filename in vault-manifest.json mcp_never_expose",
    ],
    staticContentRoots: [
      "work/active",
      "work/archive",
      "work/incidents",
      "work/1-1",
      "org/people",
      "org/teams",
      "perf/brag",
      "perf/evidence",
      "perf/competencies",
      "brain",
      "reference",
    ],
  },
  source: {
    commit: "216821bbc030211476e68270e287c915d09b4390",
    license: "MIT",
    repository: "https://github.com/breferrari/obsidian-mind",
    reviewedAt: "2026-07-30",
    version: "8.2.0",
  },
  toolPolicy: {
    localReadTools: ["search", "expand", "recall", "reason", "health"],
    localWriteTools: ["record_work", "remember"],
    rule: "Obsidian Mind write tools are direct vault writes. Only OWD localVaultAccess primary-writer may use them for an owner-requested bounded task; every later agent treats them as unavailable unless the owner completes an explicit bounded handoff. A general memory names why it generalizes, and promotion copies the lesson into brain/ while retaining the memory with its promoted marker.",
  },
} as const satisfies OwdVaultRuntimeCompatibilityProfile;

function normalizedMcpUrl(value: string): string {
  const url = new URL(value);
  const localHttp =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("OWD MCP requires HTTPS except on localhost.");
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new Error("OWD MCP URLs cannot contain credentials or fragments.");
  }
  return url.toString();
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/**
 * Claude Code updates the existing project-scoped .mcp.json entry in place,
 * preserving Obsidian Mind's qmd server instead of replacing the file.
 */
export function createObsidianMindProjectMcpCommand(mcpUrl: string): string {
  return `claude mcp add --transport http --scope project md-evolved ${shellSingleQuote(
    normalizedMcpUrl(mcpUrl),
  )}`;
}

/**
 * Portable merge fragment for clients that read Claude-style .mcp.json.
 * The UI must label it as a merge, never as a replacement file.
 */
export function createObsidianMindMcpMergeConfig(mcpUrl: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        "md-evolved": {
          type: "http",
          url: normalizedMcpUrl(mcpUrl),
        },
      },
    },
    null,
    2,
  );
}

export function serializeObsidianMindCompatibilityProfile(): string {
  return `${JSON.stringify(OBSIDIAN_MIND_COMPATIBILITY_PROFILE, null, 2)}\n`;
}

export const OBSIDIAN_MIND_CONTINUITY_GUIDANCE = `### Obsidian Mind compatibility

- If \`vault-manifest.json\` has \`"template": "obsidian-mind"\`, keep its native note layout. Use \`documentationPlan.decision = "keep-current-locations"\`; do not relocate its notes into \`docs/\`.
- Use the OWD Project UUID stored in \`.owdignore\` for Project authorization and resume. Never substitute the Obsidian Mind \`.om-project\` routing name or a folder name.
- In a fresh session, call \`resume_project\` as the first OWD action. Treat the writer role as unconfirmed until the current \`localVaultAccess.role\` returns; a session restart does not change the durable assignment. Treat **OWD resume project** as a direct receipt-based resume request, not a reconnect.
- Keep both MCP roles: OWD is the remote, owner-approved Project and provenance boundary; Obsidian Mind \`om\` is the local graph and scoped-memory layer. Never replace the existing \`qmd\` or \`om\` server entry when adding OWD.
- Treat \`memories/\`, notes marked \`private\`, and filenames in \`mcp_never_expose\` as outside ordinary OWD Project context. Use only concrete content roots that exist locally and are relevant to the requested Project.
- Do not widen a dynamic folder glob such as \`perf/h*-*/\` to its parent. It is omitted from the automatic remote profile; the owner may expose a needed cycle by listing its exact concrete folder—and every other intended root—in \`mcp_exposed_roots\`.
- Obsidian Mind \`search\`, \`expand\`, \`recall\`, \`reason\`, and \`health\` are read paths. Its \`record_work\` and \`remember\` tools write directly to the vault and therefore obey \`localVaultAccess\`: a read-only collaborator must not call them without an explicit bounded writer handoff.
- Before implementation commits to an approach, put the relevant Mind consultation result in the OWD Artifact or Handoff: supporting Decisions, contrary evidence, or an explicit statement that nothing applicable was recorded.
- When \`remember\` uses \`scope: "general"\`, include the optional \`generality\` rationale. When a lesson is promoted into \`brain/\`, copy rather than delete the memory and retain its \`promoted\` marker so cross-repository recall and hygiene remain correct.
- Prefer Obsidian Mind for local graph discovery and scoped recall; prefer OWD for the current Work Packet, owner Decisions, shared Artifacts, provenance, and multi-agent handoff. Do not duplicate the same durable record in both systems unless the owner asks.`;

export const OBSIDIAN_MIND_PROFILE_PROMPT = `Connect this Obsidian Mind workspace to OWD without changing either protocol.

1. Read vault-manifest.json. Continue with this profile only when template is obsidian-mind.
2. Preserve every existing MCP entry. OWD runs beside qmd/om as a remote Streamable HTTP server; it does not replace or proxy the local server.
3. Read AGENTS.md and CLAUDE.md. Read .owdignore when present, then call resume_project with its exact Project UUID and context policy as the first OWD action. Until it returns, the writer role is unconfirmed; never infer it from session identity or Mind tool access. Treat "OWD resume project" as this receipt-based resume, with no reconnect or new approval. If no receipt exists, call open_project with the user's visible Project name.
4. For a new Project, keep Obsidian Mind's native note locations. Select only relevant concrete roots returned by OWD; never widen a dynamic folder glob. If a needed cycle such as perf/h2-2026 is absent, explain that mcp_exposed_roots replaces the derived list, then ask the owner to list that exact folder plus every other intended root and let OWD Sync refresh the profile. Never include memories/, private notes, mcp_never_expose filenames, or runtime/infrastructure files as ordinary source context.
5. Use om search/expand/recall/reason for local knowledge work. Before implementation commits to an approach, include the relevant consultation result in the OWD Artifact or Handoff: supporting Decisions, contrary evidence, or an explicit statement that nothing applicable was recorded.
6. Before any direct vault write—including om record_work or remember—obey the localVaultAccess role returned by OWD. A read-only collaborator proposes or hands off; it does not write. A general memory includes its generality rationale. Promotion copies the lesson into brain/, retains the memory, and records its promoted marker.
7. Persist the OWD continuity receipt and marked AGENTS.md block without replacing any Obsidian Mind instructions.`;
