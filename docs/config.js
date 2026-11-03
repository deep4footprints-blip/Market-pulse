// Set workerUrl to your deployed Cloudflare Worker (no trailing slash), e.g.
//   workerUrl: "https://market-pulse-proxy.<your-subdomain>.workers.dev"
// Empty = use only the scheduled GitHub Actions snapshot (data/snapshot.json).
// If the Worker is set but unreachable, the page falls back to that snapshot automatically.
window.MARKET_PULSE = {
  workerUrl: "",
};
