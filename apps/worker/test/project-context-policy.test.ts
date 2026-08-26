import { describe, expect, it } from "vitest";
import type { ActiveAgentGrant } from "../src/agent-access-store";
import {
  compileProjectContextPolicy,
  OWD_LOCAL_VAULT_WRITE_SUMMARY,
  ProjectContextPolicyProblem,
  projectContextFileContent,
  projectContextSelectorSha256,
  projectContinuityReceipt,
} from "../src/project-context-policy";

const vaultId = "11111111-1111-4111-8111-111111111111";
const projectId = "33333333-3333-4333-8333-333333333333";

const grant: ActiveAgentGrant = {
  approvedRestoreIds: [],
  audience: "https://owd.example/mcp",
  clientId: "test-client",
  clientName: "Test agent",
  clientOrigin: "https://agent.example",
  id: "22222222-2222-4222-8222-222222222222",
  pathKeyPrefixes: ["projects/"],
  pathPrefixes: ["Projects"],
  runtimeProfile: null,
  scopes: ["vault.read", "project.initialize.request"],
  vaultId,
  vaultName: "Test vault",
};

describe("Project context policy", () => {
  it("normalizes and pins an explicit include/exclude policy", async () => {
    const compiled = compileProjectContextPolicy(
      {
        excludePaths: ["Projects/Work/Private/"],
        format: "owd-project-context-v1",
        includePaths: ["Projects/Work/"],
      },
      {
        folderBoundary: "Projects",
        grant,
        sourcePaths: ["Projects/Work/Brief.md"],
        vaultId,
      },
    );
    expect(compiled).toEqual({
      member: {
        exclusions: [
          {
            path: "Projects/Work/Private",
            pathKey: "projects/work/private",
          },
        ],
        pathPrefixes: [
          {
            path: "Projects/Work",
            pathKey: "projects/work",
          },
        ],
        vaultId,
      },
      policy: {
        excludePaths: ["Projects/Work/Private"],
        format: "owd-project-context-v1",
        includePaths: ["Projects/Work"],
      },
    });
    const selectorSha256 = await projectContextSelectorSha256([
      compiled.member,
    ]);
    const receipt = projectContinuityReceipt(
      compiled.policy,
      selectorSha256,
      projectId,
    );
    expect(receipt).toMatchObject({
      contextFilePath: ".owdignore",
      instructionFilePath: "AGENTS.md",
      requiredTool: "resume_project",
      selectorSha256,
    });
    expect(receipt.contextFileContent).toBe(
      projectContextFileContent(compiled.policy, projectId),
    );
    expect(receipt.managedInstructionBlock).toContain(
      "At the start of every new task",
    );
    expect(receipt.managedInstructionBlock).toContain(
      "first agent that establishes an OWD Project for this vault",
    );
    expect(receipt.managedInstructionBlock).toContain(
      "inspect `localVaultAccess.role`",
    );
    expect(receipt.managedInstructionBlock).toContain(
      "writer role is **unconfirmed**",
    );
    expect(receipt.managedInstructionBlock).toContain(
      "**MDevolved resume project**",
    );
    expect(receipt.managedInstructionBlock).toContain("**OWD resume project**");
    expect(receipt.managedInstructionBlock).toContain(
      "A `read-only-collaborator` must warn the owner",
    );
    expect(receipt.managedInstructionBlock).toContain(
      "A different client must remain read-only",
    );
    expect(receipt.managedInstructionBlock).toContain(
      "most-recently-focused vault",
    );
    expect(receipt.managedInstructionBlock).toContain(
      "`vault=<exact vault name>` first",
    );
    expect(receipt.managedInstructionBlock).toContain("not a filesystem lock");
    expect(receipt.managedInstructionBlock).toContain(
      "### Obsidian Mind compatibility",
    );
    expect(receipt.managedInstructionBlock).toContain(
      'vault-manifest.json` has `"template": "obsidian-mind"',
    );
    expect(receipt.managedInstructionBlock).toContain(
      "`record_work` and `remember` tools write directly to the vault",
    );
    expect(receipt.managedInstructionBlock).toContain(
      'documentationPlan.decision = "keep-current-locations"',
    );
    expect(receipt.managedInstructionBlock).toContain("### Eve compatibility");
    expect(receipt.managedInstructionBlock).toContain(
      "`agent/connections/owd.ts`",
    );
    expect(receipt.managedInstructionBlock).toContain(
      "unique Vercel Connect connector UID",
    );
    expect(receipt.managedInstructionBlock).toContain(
      "Top-level schedules cannot borrow a user's OWD grant",
    );
    expect(receipt.managedInstructionBlock).toContain(
      "### Albatross compatibility",
    );
    expect(receipt.managedInstructionBlock).toContain(
      "`mcp__owd__resume_project` first",
    );
    expect(receipt.managedInstructionBlock).toContain("`timeoutSeconds: 20`");
    expect(receipt.managedInstructionBlock).toContain(
      "`X-OWD-Albatross-Participant`",
    );
    expect(receipt.managedInstructionBlock.length).toBeLessThanOrEqual(8_192);
    expect(OWD_LOCAL_VAULT_WRITE_SUMMARY).toContain(
      "A restarted session using that same authorized client keeps the role",
    );
    expect(OWD_LOCAL_VAULT_WRITE_SUMMARY).toContain("call resume_project");
    expect(OWD_LOCAL_VAULT_WRITE_SUMMARY).toContain(
      "the global Agents screen never promotes it",
    );
  });

  it.each([
    {
      label: "a missing policy format",
      policy: {
        excludePaths: [],
        includePaths: ["Projects/Work"],
      },
      sourcePaths: [],
    },
    {
      label: "a traversal path",
      policy: {
        excludePaths: [],
        format: "owd-project-context-v1",
        includePaths: ["Projects/../Private"],
      },
      sourcePaths: [],
    },
    {
      label: "an include outside the owner-approved folder",
      policy: {
        excludePaths: [],
        format: "owd-project-context-v1",
        includePaths: [""],
      },
      sourcePaths: ["Projects/Brief.md"],
    },
    {
      label: "an exclusion outside every include",
      policy: {
        excludePaths: ["Projects/Private"],
        format: "owd-project-context-v1",
        includePaths: ["Projects/Work"],
      },
      sourcePaths: ["Projects/Work/Brief.md"],
    },
    {
      label: "a source note excluded from Project context",
      policy: {
        excludePaths: ["Projects/Work/Brief.md"],
        format: "owd-project-context-v1",
        includePaths: ["Projects/Work"],
      },
      sourcePaths: ["Projects/Work/Brief.md"],
    },
    {
      label: "case-insensitive duplicate prefixes",
      policy: {
        excludePaths: [],
        format: "owd-project-context-v1",
        includePaths: ["Projects/Work", "projects/work"],
      },
      sourcePaths: [],
    },
    {
      label: "redundant nested includes",
      policy: {
        excludePaths: [],
        format: "owd-project-context-v1",
        includePaths: ["Projects", "Projects/Work"],
      },
      sourcePaths: [],
    },
  ])("rejects $label", ({ policy, sourcePaths }) => {
    expect(() =>
      compileProjectContextPolicy(policy, {
        folderBoundary: "Projects",
        grant,
        sourcePaths,
        vaultId,
      }),
    ).toThrow(ProjectContextPolicyProblem);
  });
});
