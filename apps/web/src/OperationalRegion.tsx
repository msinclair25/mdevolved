import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type OperationalRegionId =
  | "agents"
  | "architecture"
  | "collaboration"
  | "health"
  | "library"
  | "recovery"
  | "vaults";

const PREFERENCE_KEY = "owd.presentation.regions.v1";
export const OPERATIONAL_REGION_OPEN_EVENT = "owd:open-operational-region";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function preferenceRecord(storage: StorageLike): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(PREFERENCE_KEY) ?? "{}");
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
      ),
    );
  } catch {
    return {};
  }
}

export function readOperationalRegionPreference(
  storage: StorageLike,
  id: OperationalRegionId,
): boolean | undefined {
  return preferenceRecord(storage)[id];
}

export function writeOperationalRegionPreference(
  storage: StorageLike,
  id: OperationalRegionId,
  open: boolean,
): void {
  try {
    const preferences = preferenceRecord(storage);
    preferences[id] = open;
    storage.setItem(PREFERENCE_KEY, JSON.stringify(preferences));
  } catch {
    // Presentation preferences must never block an owner operation.
  }
}

export function revealOperationalRegion(id: OperationalRegionId): void {
  openOperationalRegion(id);
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const region = document
        .getElementById(`${id}-region-heading`)
        ?.closest<HTMLElement>(".operational-region");
      if (region === undefined || region === null) return;
      if (window.matchMedia("(max-width: 980px)").matches) {
        const navigation =
          document.querySelector<HTMLElement>(".workspace-sidebar");
        const navigationBottom =
          navigation?.getBoundingClientRect().bottom ?? 0;
        const top =
          window.scrollY +
          region.getBoundingClientRect().top -
          navigationBottom -
          12;
        window.scrollTo({ behavior: "smooth", top: Math.max(0, top) });
      } else {
        region.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }
    });
  });
}

export function openOperationalRegion(id: OperationalRegionId): void {
  window.dispatchEvent(
    new CustomEvent<OperationalRegionId>(OPERATIONAL_REGION_OPEN_EVENT, {
      detail: id,
    }),
  );
}

function browserPreference(id: OperationalRegionId): boolean | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return readOperationalRegionPreference(window.localStorage, id);
  } catch {
    return undefined;
  }
}

function rememberBrowserPreference(
  id: OperationalRegionId,
  open: boolean,
): void {
  try {
    writeOperationalRegionPreference(window.localStorage, id, open);
  } catch {
    // Access to device-local storage can be disabled independently.
  }
}

type Props = {
  attention?: "error" | "none" | "pending";
  autoOpen?: boolean;
  children: ReactNode;
  heading: string;
  id: OperationalRegionId;
  kicker: string;
  lazy?: boolean;
  onOpenChange?: (open: boolean) => void;
  summary: ReactNode;
};

export function OperationalRegion({
  attention = "none",
  autoOpen = false,
  children,
  heading,
  id,
  kicker,
  lazy = false,
  onOpenChange,
  summary,
}: Props) {
  const [open, setOpen] = useState(
    () => autoOpen || browserPreference(id) === true,
  );
  const [hasOpened, setHasOpened] = useState(() => open || !lazy);
  const headerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const setVisibility = useCallback(
    (next: boolean, persist: boolean) => {
      if (next) setHasOpened(true);
      if (
        !next &&
        contentRef.current?.contains(document.activeElement ?? null)
      ) {
        toggleRef.current?.focus({ preventScroll: true });
      }
      const beforeTop =
        (headerRef.current?.getClientRects().length ?? 0) > 0
          ? headerRef.current?.getBoundingClientRect().top
          : undefined;
      setOpen(next);
      if (persist) rememberBrowserPreference(id, next);
      window.requestAnimationFrame(() => {
        const afterTop = headerRef.current?.getBoundingClientRect().top;
        if (
          beforeTop !== undefined &&
          afterTop !== undefined &&
          Number.isFinite(beforeTop) &&
          Number.isFinite(afterTop)
        ) {
          window.scrollBy({ behavior: "auto", top: afterTop - beforeTop });
        }
      });
    },
    [id],
  );

  useEffect(() => {
    if (autoOpen) setVisibility(true, false);
  }, [autoOpen, setVisibility]);

  useEffect(() => {
    const openRequested = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === id) {
        setVisibility(true, false);
      }
    };
    window.addEventListener(OPERATIONAL_REGION_OPEN_EVENT, openRequested);
    return () =>
      window.removeEventListener(OPERATIONAL_REGION_OPEN_EVENT, openRequested);
  }, [id, setVisibility]);

  useEffect(() => {
    onOpenChange?.(open);
  }, [onOpenChange, open]);

  const contentId = `${id}-region-content`;
  const headingId = `${id}-region-heading`;

  return (
    <section
      className={`operational-region operational-region--${attention}${
        open ? " operational-region--open" : ""
      }`}
      data-region={id}
      aria-labelledby={headingId}
    >
      <header className="operational-region-header" ref={headerRef}>
        <div>
          <span className="section-kicker">{kicker}</span>
          <h2 id={headingId}>{heading}</h2>
          <div className="operational-region-summary" aria-live="polite">
            {summary}
          </div>
        </div>
        <button
          aria-controls={contentId}
          aria-expanded={open}
          className="operational-region-toggle"
          ref={toggleRef}
          type="button"
          onClick={() => setVisibility(!open, true)}
        >
          {open ? "Collapse" : "Open"}
          <span aria-hidden="true">{open ? "−" : "+"}</span>
        </button>
      </header>
      <div
        className="operational-region-content"
        hidden={!open}
        id={contentId}
        ref={contentRef}
      >
        {hasOpened ? children : null}
      </div>
    </section>
  );
}
