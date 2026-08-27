import "./styles.css";

document.documentElement.classList.add("js");

const header = document.querySelector("[data-header]");
const navToggle = document.querySelector("[data-nav-toggle]");
const nav = document.querySelector("[data-nav]");

const setNavigationOpen = (isOpen) => {
  navToggle?.setAttribute("aria-expanded", String(isOpen));
  navToggle
    ?.querySelector(".sr-only")
    ?.replaceChildren(isOpen ? "Close navigation" : "Open navigation");
  nav?.toggleAttribute("data-open", isOpen);
};

const closeNavigation = () => setNavigationOpen(false);

navToggle?.addEventListener("click", () => {
  const isOpen = navToggle.getAttribute("aria-expanded") === "true";
  setNavigationOpen(!isOpen);
});

nav?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", closeNavigation);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeNavigation();
  }
});

const updateHeader = () => {
  header?.toggleAttribute("data-scrolled", window.scrollY > 24);
};

updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

const revealElements = document.querySelectorAll("[data-reveal]");

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.setAttribute("data-visible", "");
          observer.unobserve(entry.target);
        }
      }
    },
    { rootMargin: "0px 0px -10%", threshold: 0.08 },
  );

  revealElements.forEach((element) => observer.observe(element));
} else {
  revealElements.forEach((element) => element.setAttribute("data-visible", ""));
}

const alphaForm = document.querySelector("[data-alpha-form]");
const alphaSubmit = document.querySelector("[data-alpha-submit]");
const alphaSubmitLabel = document.querySelector("[data-alpha-submit-label]");
const alphaStatus = document.querySelector("[data-alpha-status]");

const setAlphaStatus = (message, state) => {
  if (!(alphaStatus instanceof HTMLElement)) return;
  alphaStatus.textContent = message;
  if (state) {
    alphaStatus.dataset.state = state;
  } else {
    delete alphaStatus.dataset.state;
  }
};

if (alphaForm instanceof HTMLFormElement) {
  alphaForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!alphaForm.reportValidity()) return;

    const formData = new FormData(alphaForm);
    const payload = {
      name: formData.get("name"),
      email: formData.get("email"),
      tools: formData.get("tools"),
      testPlan: formData.get("testPlan"),
      website: formData.get("website"),
    };

    if (alphaSubmit instanceof HTMLButtonElement) {
      alphaSubmit.disabled = true;
      alphaSubmit.setAttribute("aria-busy", "true");
    }
    if (alphaSubmitLabel instanceof HTMLElement) {
      alphaSubmitLabel.textContent = "Sending request…";
    }
    setAlphaStatus("", "");

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);

    try {
      const response = await fetch(alphaForm.action, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) {
        const message =
          typeof result?.error?.message === "string"
            ? result.error.message
            : "Your request could not be sent. Try again shortly.";
        throw new Error(message);
      }

      alphaForm.reset();
      setAlphaStatus(
        typeof result.message === "string"
          ? result.message
          : "Request sent. We will reply by email if there is a fit.",
        "success",
      );
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === "AbortError"
          ? "The request timed out. Check your connection and try again."
          : error instanceof Error
            ? error.message
            : "Your request could not be sent. Try again shortly.";
      setAlphaStatus(message, "error");
    } finally {
      window.clearTimeout(timeout);
      if (alphaSubmit instanceof HTMLButtonElement) {
        alphaSubmit.disabled = false;
        alphaSubmit.removeAttribute("aria-busy");
      }
      if (alphaSubmitLabel instanceof HTMLElement) {
        alphaSubmitLabel.textContent = "Request alpha access";
      }
    }
  });
}
