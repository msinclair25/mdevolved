import { z } from "zod";

// OWD serves the browser under a strict CSP. Configure Zod before any schema
// module is evaluated so its optional object-parser JIT never probes
// `new Function()` in the browser.
z.config({ jitless: true });

export { z };
