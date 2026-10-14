// Browser requests use public ingress. Service bindings are runtime-only and
// cannot be consumed by this static Vite app.
export const API_BASE_URL = (
  import.meta.env.VITE_API_URL ||
  (import.meta.env.PROD ? "/api" : "http://localhost:4000/api")
).replace(/\/$/, "");
