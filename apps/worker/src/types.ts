import type { RuntimeEnv } from "./runtime-config";

export type AppBindings = {
  Bindings: RuntimeEnv;
  Variables: {
    requestId: string;
  };
};
