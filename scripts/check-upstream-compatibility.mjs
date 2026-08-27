import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const configUrl = new URL("compatibility/upstreams.json", root);
const githubApi = "https://api.github.com";
const githubHeaders = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "owd-upstream-compatibility",
};

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function assertSha(value, label) {
  assertString(value, label);
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${label} must be a full lowercase Git commit SHA.`);
  }
}

export async function loadConfiguration() {
  const configuration = JSON.parse(await readFile(configUrl, "utf8"));
  if (configuration.schemaVersion !== 1) {
    throw new Error("Unsupported upstream compatibility schema version.");
  }
  assertString(configuration.monitorRepository, "monitorRepository");
  assertString(configuration.issueLabel?.name, "issueLabel.name");
  assertString(configuration.issueLabel?.color, "issueLabel.color");
  assertString(configuration.issueLabel?.description, "issueLabel.description");
  if (
    !Array.isArray(configuration.profiles) ||
    configuration.profiles.length === 0
  ) {
    throw new Error("At least one upstream profile is required.");
  }

  const ids = new Set();
  for (const profile of configuration.profiles) {
    assertString(profile.id, "profile.id");
    assertString(profile.name, `${profile.id}.name`);
    if (ids.has(profile.id)) {
      throw new Error(`Duplicate upstream profile id: ${profile.id}`);
    }
    ids.add(profile.id);
    if (profile.source?.kind !== "github-release") {
      throw new Error(`${profile.id}.source must use github-release.`);
    }
    assertString(profile.source.repository, `${profile.id}.source.repository`);
    assertString(profile.source.releaseTag, `${profile.id}.source.releaseTag`);
    assertSha(profile.source.commit, `${profile.id}.source.commit`);
    assertString(profile.source.reviewedAt, `${profile.id}.source.reviewedAt`);
    if (!Array.isArray(profile.criticalPaths)) {
      throw new Error(`${profile.id}.criticalPaths must be an array.`);
    }
    for (const pattern of profile.criticalPaths) {
      assertString(pattern, `${profile.id}.criticalPaths[]`);
    }
    if (!Array.isArray(profile.evidence) || profile.evidence.length === 0) {
      throw new Error(`${profile.id}.evidence must not be empty.`);
    }
    for (const evidence of profile.evidence) {
      assertString(evidence.path, `${profile.id}.evidence.path`);
      if (
        !Array.isArray(evidence.requiredMarkers) ||
        evidence.requiredMarkers.length === 0
      ) {
        throw new Error(
          `${profile.id}.evidence.requiredMarkers must not be empty.`,
        );
      }
      for (const marker of evidence.requiredMarkers) {
        assertString(marker, `${profile.id}.evidence.requiredMarkers[]`);
      }
    }
    for (const dependency of profile.dependencies ?? []) {
      if (dependency.kind !== "npm") {
        throw new Error(`${profile.id} has an unsupported dependency kind.`);
      }
      assertString(dependency.package, `${profile.id}.dependency.package`);
      assertString(dependency.version, `${profile.id}.dependency.version`);
      assertString(dependency.integrity, `${profile.id}.dependency.integrity`);
    }
  }
  return configuration;
}

export async function validateEvidence(configuration) {
  const failures = [];
  for (const profile of configuration.profiles) {
    for (const evidence of profile.evidence) {
      let contents;
      try {
        contents = await readFile(new URL(evidence.path, root), "utf8");
      } catch {
        failures.push(`${profile.id}: missing evidence file ${evidence.path}`);
        continue;
      }
      for (const marker of evidence.requiredMarkers) {
        if (!contents.includes(marker)) {
          failures.push(
            `${profile.id}: ${evidence.path} is missing reviewed marker ${JSON.stringify(marker)}`,
          );
        }
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(
      ["Upstream compatibility evidence is inconsistent:", ...failures].join(
        "\n",
      ),
    );
  }
}

function globRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*")
    .replaceAll("?", "[^/]");
  return new RegExp(`^${escaped}$`, "u");
}

export function matchesCriticalPath(path, patterns) {
  return patterns.some((pattern) => globRegex(pattern).test(path));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `${options.method ?? "GET"} ${url} failed with ${response.status}: ${body.slice(0, 500)}`,
    );
  }
  return response.json();
}

async function githubJson(path, token, options = {}) {
  return requestJson(`${githubApi}${path}`, {
    ...options,
    headers: {
      ...githubHeaders,
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      ...options.headers,
    },
  });
}

async function resolveTagCommit(repository, tag, token) {
  let object = (
    await githubJson(
      `/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
      token,
    )
  ).object;
  for (let depth = 0; depth < 4 && object.type === "tag"; depth += 1) {
    object = (
      await githubJson(`/repos/${repository}/git/tags/${object.sha}`, token)
    ).object;
  }
  if (object.type !== "commit") {
    throw new Error(
      `${repository} tag ${tag} did not resolve to a Git commit.`,
    );
  }
  return object.sha;
}

async function inspectGitHubSource(profile, token) {
  const latest = await githubJson(
    `/repos/${profile.source.repository}/releases/latest`,
    token,
  );
  const latestCommit = await resolveTagCommit(
    profile.source.repository,
    latest.tag_name,
    token,
  );
  const drift =
    latest.tag_name !== profile.source.releaseTag ||
    latestCommit !== profile.source.commit;
  let changedFiles = [];
  let compareUrl;
  let compareIncomplete = false;
  if (drift) {
    const comparison = await githubJson(
      `/repos/${profile.source.repository}/compare/${profile.source.commit}...${latestCommit}`,
      token,
    );
    changedFiles = (comparison.files ?? []).map((file) => file.filename);
    compareUrl = comparison.html_url;
    compareIncomplete =
      comparison.status !== "ahead" ||
      comparison.total_commits !== comparison.ahead_by ||
      changedFiles.length >= 300;
  }
  const criticalFiles = changedFiles.filter((path) =>
    matchesCriticalPath(path, profile.criticalPaths),
  );
  return {
    kind: "github-release",
    drift,
    reviewedTag: profile.source.releaseTag,
    reviewedCommit: profile.source.commit,
    latestTag: latest.tag_name,
    latestCommit,
    releaseUrl: latest.html_url,
    publishedAt: latest.published_at,
    compareUrl,
    compareIncomplete,
    changedFiles,
    criticalFiles,
  };
}

async function inspectNpmDependency(dependency) {
  const encodedPackage = encodeURIComponent(dependency.package);
  const latest = await requestJson(
    `https://registry.npmjs.org/${encodedPackage}/latest`,
    { headers: { "User-Agent": "owd-upstream-compatibility" } },
  );
  return {
    kind: "npm",
    package: dependency.package,
    drift:
      latest.version !== dependency.version ||
      latest.dist?.integrity !== dependency.integrity,
    reviewedVersion: dependency.version,
    reviewedIntegrity: dependency.integrity,
    latestVersion: latest.version,
    latestIntegrity: latest.dist?.integrity,
    packageUrl: `https://www.npmjs.com/package/${dependency.package}`,
  };
}

export async function inspectProfile(profile, token) {
  const source = await inspectGitHubSource(profile, token);
  const dependencies = await Promise.all(
    (profile.dependencies ?? []).map(inspectNpmDependency),
  );
  return {
    id: profile.id,
    name: profile.name,
    reviewedAt: profile.source.reviewedAt,
    source,
    dependencies,
    drift: source.drift || dependencies.some((entry) => entry.drift),
  };
}

function markdownLink(label, url) {
  return url === undefined ? label : `[${label}](${url})`;
}

function inlineCode(value) {
  return `\`${value}\``;
}

export function renderProfileReport(result) {
  const lines = [
    `<!-- owd-upstream:${result.id} -->`,
    `# ${result.name} compatibility ${result.drift ? "review required" : "current"}`,
    "",
    `MDevolved last reviewed this profile on **${result.reviewedAt}**.`,
    "",
    "| Contract | Reviewed | Latest | Status |",
    "| --- | --- | --- | --- |",
    `| ${result.source.kind} | \`${result.source.reviewedTag}\` (\`${result.source.reviewedCommit.slice(0, 12)}\`) | ${markdownLink(inlineCode(result.source.latestTag), result.source.releaseUrl)} (\`${result.source.latestCommit.slice(0, 12)}\`) | ${result.source.drift ? "Review required" : "Current"} |`,
  ];
  for (const dependency of result.dependencies) {
    lines.push(
      `| npm \`${dependency.package}\` | \`${dependency.reviewedVersion}\` | ${markdownLink(inlineCode(dependency.latestVersion), dependency.packageUrl)} | ${dependency.drift ? "Review required" : "Current"} |`,
    );
  }
  if (result.source.drift) {
    lines.push("", "## Source impact", "");
    if (result.source.compareUrl !== undefined) {
      lines.push(
        `[Review the complete source comparison](${result.source.compareUrl}).`,
      );
    }
    if (result.source.compareIncomplete) {
      lines.push(
        "",
        "> [!WARNING]",
        "> GitHub could not prove a complete linear comparison. Treat the release as compatibility-critical.",
      );
    }
    if (result.source.criticalFiles.length > 0) {
      lines.push(
        "",
        "**Compatibility-critical paths changed:**",
        "",
        ...result.source.criticalFiles.map((path) => `- \`${path}\``),
      );
    } else {
      lines.push(
        "",
        "No configured compatibility-critical path changed, but the release pin still requires a human review before MDevolved advances its claim.",
      );
    }
  }
  if (result.dependencies.some((entry) => entry.drift)) {
    lines.push(
      "",
      "## Dependency impact",
      "",
      "Recompile the generated integration against every changed package and verify its authentication, identity, and connection contract before advancing the reviewed pin.",
    );
  }
  lines.push(
    "",
    "## Review checklist",
    "",
    "- [ ] Read the upstream release notes and complete source comparison.",
    "- [ ] Re-run the profile's deterministic contract tests.",
    "- [ ] Update the compatibility manifest, profile source, documentation, and badges together.",
    "- [ ] Confirm MDevolved still uses its standard MCP transport, OAuth authority, and Project tools.",
    "- [ ] Merge the reviewed pin; this issue will close automatically on the next monitor run.",
    "",
    "_This issue is maintained by `.github/workflows/upstream-compatibility.yml`. It never auto-advances an MDevolved compatibility claim._",
  );
  return `${lines.join("\n")}\n`;
}

async function ensureLabel(repository, label, token) {
  const path = `/repos/${repository}/labels/${encodeURIComponent(label.name)}`;
  const response = await fetch(`${githubApi}${path}`, {
    headers: { ...githubHeaders, Authorization: `Bearer ${token}` },
  });
  if (response.ok) return;
  if (response.status !== 404) {
    throw new Error(
      `Unable to inspect compatibility label: ${response.status}`,
    );
  }
  await githubJson(`/repos/${repository}/labels`, token, {
    method: "POST",
    body: JSON.stringify(label),
  });
}

async function findIssue(repository, marker, token) {
  const issues = await githubJson(
    `/repos/${repository}/issues?state=all&per_page=100`,
    token,
  );
  return issues.find(
    (issue) =>
      issue.pull_request === undefined &&
      typeof issue.body === "string" &&
      issue.body.includes(marker),
  );
}

async function synchronizeIssue(configuration, result, token) {
  const marker = `<!-- owd-upstream:${result.id} -->`;
  const existing = await findIssue(
    configuration.monitorRepository,
    marker,
    token,
  );
  if (result.drift) {
    await ensureLabel(
      configuration.monitorRepository,
      configuration.issueLabel,
      token,
    );
    const body = renderProfileReport(result);
    const title = `[Upstream review] ${result.name}`;
    if (existing === undefined) {
      await githubJson(
        `/repos/${configuration.monitorRepository}/issues`,
        token,
        {
          method: "POST",
          body: JSON.stringify({
            title,
            body,
            labels: [configuration.issueLabel.name],
          }),
        },
      );
      return "opened";
    }
    await githubJson(
      `/repos/${configuration.monitorRepository}/issues/${existing.number}`,
      token,
      {
        method: "PATCH",
        body: JSON.stringify({
          title,
          body,
          state: "open",
          labels: [configuration.issueLabel.name],
        }),
      },
    );
    return existing.state === "open" ? "updated" : "reopened";
  }
  if (existing !== undefined && existing.state === "open") {
    await githubJson(
      `/repos/${configuration.monitorRepository}/issues/${existing.number}/comments`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          body: `Reviewed pins now match the latest upstream contracts. Closing automatically on ${new Date().toISOString().slice(0, 10)}.`,
        }),
      },
    );
    await githubJson(
      `/repos/${configuration.monitorRepository}/issues/${existing.number}`,
      token,
      {
        method: "PATCH",
        body: JSON.stringify({ state: "closed" }),
      },
    );
    return "closed";
  }
  return "current";
}

async function writeSummary(results) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined) return;
  const body = [
    "# MDevolved upstream compatibility",
    "",
    ...results.flatMap((result) => [
      `## ${result.name}`,
      "",
      result.drift
        ? "A newer upstream contract requires review."
        : "The reviewed pin matches the latest upstream contract.",
      "",
      `- Reviewed: \`${result.source.reviewedTag}\``,
      `- Latest: \`${result.source.latestTag}\``,
      ...result.dependencies.map(
        (dependency) =>
          `- \`${dependency.package}\`: reviewed \`${dependency.reviewedVersion}\`, latest \`${dependency.latestVersion}\``,
      ),
      "",
    ]),
  ].join("\n");
  await appendFile(summaryPath, `${body}\n`);
}

export async function run({
  synchronizeIssues = false,
  token = process.env.GITHUB_TOKEN,
} = {}) {
  const configuration = await loadConfiguration();
  await validateEvidence(configuration);
  if (
    synchronizeIssues &&
    process.env.GITHUB_REPOSITORY !== configuration.monitorRepository
  ) {
    console.log(
      `Skipping issue synchronization outside ${configuration.monitorRepository}.`,
    );
    return [];
  }
  if (synchronizeIssues && token === undefined) {
    throw new Error("GITHUB_TOKEN is required to synchronize issues.");
  }
  const results = [];
  for (const profile of configuration.profiles) {
    const result = await inspectProfile(profile, token);
    results.push(result);
    console.log(renderProfileReport(result));
    if (synchronizeIssues) {
      const action = await synchronizeIssue(configuration, result, token);
      console.log(`${result.name}: issue ${action}.`);
    }
  }
  await writeSummary(results);
  return results;
}

const currentEntry =
  process.argv[1] === undefined
    ? undefined
    : pathToFileURL(process.argv[1]).href;
if (currentEntry === import.meta.url) {
  const validateOnly = process.argv.includes("--validate");
  const synchronizeIssues = process.argv.includes("--sync-issues");
  try {
    if (validateOnly) {
      const configuration = await loadConfiguration();
      await validateEvidence(configuration);
      console.log("Upstream compatibility configuration is valid.");
    } else {
      const results = await run({ synchronizeIssues });
      if (!synchronizeIssues && results.some((result) => result.drift)) {
        process.exitCode = 2;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
