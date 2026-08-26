import { useRef } from "react";
import type { OperationalRegionId } from "./OperationalRegion";

export type WorkspaceSectionId = OperationalRegionId;

type NavigationGroup = {
  items: Array<{
    id: WorkspaceSectionId;
    label: string;
  }>;
  label: string;
};

const navigationGroups: NavigationGroup[] = [
  {
    label: "Guide",
    items: [{ id: "architecture", label: "How MDevolved works" }],
  },
  {
    label: "Workspace",
    items: [
      { id: "vaults", label: "Sources" },
      { id: "library", label: "Notes" },
      { id: "agents", label: "Agents" },
      { id: "collaboration", label: "Projects" },
    ],
  },
  {
    label: "Safety",
    items: [
      { id: "recovery", label: "Backup & restore" },
      { id: "health", label: "System health" },
    ],
  },
];

const sectionIds = new Set<WorkspaceSectionId>(
  navigationGroups.flatMap((group) => group.items.map((item) => item.id)),
);

const navigationItems = navigationGroups.flatMap((group) => group.items);

export function isWorkspaceSectionId(
  value: unknown,
): value is WorkspaceSectionId {
  return (
    typeof value === "string" && sectionIds.has(value as WorkspaceSectionId)
  );
}

export function workspaceSectionFromHash(hash: string): WorkspaceSectionId {
  const candidate = hash.trim().replace(/^#/u, "").toLowerCase();
  if (candidate === "start") return "architecture";
  if (candidate === "sources") return "vaults";
  return isWorkspaceSectionId(candidate) ? candidate : "architecture";
}

type Props = {
  active: WorkspaceSectionId;
  deploymentLabel: string;
  onNavigate: (section: WorkspaceSectionId) => void;
  onSignOut: () => void;
  summaries: Partial<Record<WorkspaceSectionId, string>>;
};

export function WorkspaceNavigation({
  active,
  deploymentLabel,
  onNavigate,
  onSignOut,
  summaries,
}: Props) {
  const mobileMenuRef = useRef<HTMLDetailsElement>(null);
  const activeLabel =
    navigationItems.find((item) => item.id === active)?.label ??
    "How MDevolved works";
  const closeMobileMenu = () => {
    if (mobileMenuRef.current !== null) {
      mobileMenuRef.current.open = false;
    }
  };

  return (
    <aside className="workspace-sidebar">
      <a
        className="workspace-root"
        href="#architecture"
        aria-label="Open My MDevolved home"
        onClick={(event) => {
          event.preventDefault();
          onNavigate("architecture");
        }}
      >
        <span
          className="workspace-root-icon workspace-root-icon--open"
          aria-hidden="true"
        />
        <div>
          <strong>My MDevolved</strong>
          <span>{deploymentLabel} workspace</span>
        </div>
      </a>

      <nav
        className="workspace-navigation"
        aria-label="MDevolved workspace sections"
      >
        {navigationGroups.map((group) => (
          <section className="workspace-nav-group" key={group.label}>
            <div className="workspace-nav-group-label">
              <span className="workspace-root-icon" aria-hidden="true" />
              <span>{group.label}</span>
            </div>
            <ul>
              {group.items.map((item) => {
                const selected = active === item.id;
                return (
                  <li key={item.id}>
                    <a
                      aria-current={selected ? "page" : undefined}
                      className="workspace-nav-item"
                      data-workspace-section={item.id}
                      href={`#${item.id}`}
                      onClick={(event) => {
                        event.preventDefault();
                        onNavigate(item.id);
                      }}
                    >
                      <span
                        className="workspace-nav-file-icon"
                        aria-hidden="true"
                      />
                      <span className="workspace-nav-copy">
                        <strong>{item.label}</strong>
                        <small>{summaries[item.id] ?? "Open section"}</small>
                      </span>
                      <span
                        className="workspace-nav-active-mark"
                        aria-hidden="true"
                      />
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>

      <div className="workspace-sidebar-footer">
        <span>Owner session active</span>
        <button className="text-action" type="button" onClick={onSignOut}>
          Sign out
        </button>
      </div>

      <div className="workspace-mobile-bar">
        <a
          className="workspace-mobile-root"
          href="#architecture"
          aria-label="Open My MDevolved home"
          onClick={(event) => {
            event.preventDefault();
            closeMobileMenu();
            onNavigate("architecture");
          }}
        >
          <span
            className="workspace-root-icon workspace-root-icon--open"
            aria-hidden="true"
          />
          <strong>My MDevolved</strong>
        </a>

        <details className="workspace-mobile-menu" ref={mobileMenuRef}>
          <summary aria-label={`Open workspace menu. Current: ${activeLabel}`}>
            <span className="workspace-nav-file-icon" aria-hidden="true" />
            <span className="workspace-mobile-current">
              <small>Current folder</small>
              <strong>{activeLabel}</strong>
            </span>
            <span className="workspace-mobile-chevron" aria-hidden="true">
              +
            </span>
          </summary>

          <div className="workspace-mobile-menu-panel">
            <nav aria-label="MDevolved workspace menu">
              {navigationGroups.map((group) => (
                <section
                  className="workspace-mobile-nav-group"
                  key={group.label}
                >
                  <span>{group.label}</span>
                  <ul>
                    {group.items.map((item) => {
                      const selected = active === item.id;
                      return (
                        <li key={item.id}>
                          <a
                            aria-current={selected ? "page" : undefined}
                            className="workspace-mobile-nav-item"
                            data-workspace-section={item.id}
                            href={`#${item.id}`}
                            onClick={(event) => {
                              event.preventDefault();
                              closeMobileMenu();
                              onNavigate(item.id);
                            }}
                          >
                            <span
                              className="workspace-nav-file-icon"
                              aria-hidden="true"
                            />
                            <span>
                              <strong>{item.label}</strong>
                              <small>
                                {summaries[item.id] ?? "Open section"}
                              </small>
                            </span>
                            <span
                              className="workspace-nav-active-mark"
                              aria-hidden="true"
                            />
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </nav>
            <button
              className="text-action workspace-mobile-signout"
              type="button"
              onClick={() => {
                closeMobileMenu();
                onSignOut();
              }}
            >
              Sign out
            </button>
          </div>
        </details>
      </div>
    </aside>
  );
}
