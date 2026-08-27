# Portable intelligence and agent collaboration

MDevolved helps one owner use independent AI clients as a continuous,
owner-governed Project record without becoming another model runtime. The
canonical contracts live in `packages/contracts`; this document explains the
product model around them.

## Product outcome

An owner can:

1. stay in the project folder, Markdown Workspace, or Obsidian Workspace and
   agent client already in use;
2. say **Connect this project to MDevolved**;
3. give the agent one bounded, source-cited Work Packet;
4. retain an immutable Artifact, Handoff, or Review from that agent;
5. share selected work with a second independently authorized agent;
6. record the owner's Decision without rewriting the agent's contribution;
7. resume that Decision and its evidence in a later task or client; and
8. export and recover the accepted Project record without restoring authority.

MDevolved does not call model-provider APIs, route prompts, prescribe agent roles,
record hidden conversations, or treat model confidence as owner approval.

## Responsibility boundary

| Surface           | Owns                                                                                       | Does not own                                   |
| ----------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| MDevolved Sync    | Transport for the explicitly paired Markdown Source                                        | Agent authorization or Project collaboration   |
| MDevolved MCP     | Scoped Source reads and append-only Project collaboration                                  | A model runtime or local filesystem authority  |
| MDevolved website | Setup, consent, provenance, owner Decisions, revocation, recovery, and advanced inspection | The owner's daily project workspace            |
| MDevolved Project | Durable scope, evidence, attempts, handoffs, reviews, Decisions, and portable continuity   | An agent's hidden session or provider identity |

The website prepares one exact first-Project handoff. The agent then calls
`open_project`, which creates, joins, rejoins, or resumes the matching Project.
When exact owner consent is still required, the agent receives one approval
URL and waits on the same connection. Routine packet rotation never sends the
owner through daily renewal.

## Durable records

| Record                  | Purpose                                                                           |
| ----------------------- | --------------------------------------------------------------------------------- |
| `KnowledgeSpaceVersion` | Immutable evaluated Source and folder membership                                  |
| `Project`               | Long-lived owner objective and context boundary                                   |
| `WorkItem`              | One bounded objective and definition of done                                      |
| `WorkPacket`            | Frozen input for one attempt                                                      |
| `Attempt`               | One agent's declared effort                                                       |
| `Artifact`              | Content-addressed Markdown/JSON or an inert external reference                    |
| `Handoff`               | Bounded result, evidence, risks, open questions, and suggested next action        |
| `Review`                | Findings tied to exact Artifacts and source versions                              |
| `Decision`              | Owner-authored resolution with rationale                                          |
| `ProvenanceEdge`        | Typed relationship between sources, attempts, outputs, reviews, and Decisions     |
| `OwnerEvent`            | Share, accept, reject, supersede, close, reopen, promote, quarantine, or rollback |

Agent submissions are immutable. Corrections supersede earlier records instead
of overwriting them. Visibility and truth are separate: sharing makes a record
available as untrusted work; only an owner event changes its accepted state.

## Identity and authorization

MDevolved attributes activity to the OAuth client identity it authorized. Friendly
harness, model, and role labels are claimed metadata unless a future client can
attest them independently.

Every tool call rechecks:

- client and token audience;
- exact source and Project grants;
- vault and folder boundary;
- required scope;
- expiry and explicit revocation;
- immutable Knowledge Space version;
- complete Project context policy; and
- restored-source approval.

A separately attributable writer or reviewer needs a distinct OAuth client
identity. A renamed subagent, new conversation, or reused connector does not
become another participant automatically.

## Local vault writes

MDevolved Project tools do not grant Obsidian CLI, shell, skill, or filesystem write
access. If connected agents already have local write tools, MDevolved returns an
advisory `localVaultAccess` role:

- the first Project agent for a vault is the default `primary-writer`;
- later agents are `read-only-collaborator`; and
- the owner may transfer one bounded task only after the prior writer stops.

This reduces overlapping writes and sync conflicts but is not an operating
system lock. Every local mutation still requires the owner's bounded request.

## Portable exchange

Portable Project exports use provider-neutral Markdown and JSON with:

- stable format and schema versions;
- canonical content digests;
- explicit source and Project identities;
- dependency closure;
- visibility and acceptance state;
- provenance edges;
- claimed participant metadata; and
- no D1 row ID, R2 key, hostname, or provider API requirement.

Unknown required capabilities fail before import. Imported unvetted records
remain owner-visible quarantine; they cannot be recalled, shared, applied, or
promoted until the owner creates a new review action.

## Recovery boundary

Approved Project intelligence can be included in an encrypted workspace
snapshot. An owner may additionally select quarantined Unvetted Intelligence.
Restore preserves provenance and classification but never recreates:

- sessions or passkeys;
- OAuth clients, tokens, grants, or authorization codes;
- MDevolved Sync credentials;
- live packet authority; or
- agent runtime context.

The recovery private identity remains with the owner.

## Client profiles

The universal contract is remote MCP over Streamable HTTP and OAuth. Optional
profiles make setup and routing clearer without changing authority:

- [Obsidian Mind](OBSIDIAN-MIND-COMPATIBILITY.md) remains the local graph and
  scoped-memory system while MDevolved carries selected work between agents.
- [Eve.dev](EVE-COMPATIBILITY.md) remains the durable agent runtime while MDevolved
  carries portable Project evidence and owner Decisions.

Hermes, Orca ADE, and other compliant clients can use the same MCP endpoint.
MDevolved does not launch their agents, change their sandboxes, edit their local
configuration silently, or ingest raw terminal/session history.

See the [public roadmap](ROADMAP.md) for future durable-knowledge and
versioned-skill work.
