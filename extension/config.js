// The only file you need to edit to point Lane Guard at your own application.
//
// A "lane" is one deployment environment. Lane Guard rewrites routing headers
// only on tabs you explicitly bind, so an automated agent can drive one
// environment while the rest of the browser keeps its normal routing.
//
// After editing `targets`, also update `host_permissions` in manifest.json to
// cover the same origins. Chrome cannot grant host access from a config file.

export const CONFIG = {
  // Header carrying the environment name. The bound tab receives `env` as its
  // value.
  envHeader: "x-lane",

  // Optional companion header. Set `flagHeader` to null to write only
  // `envHeader`. When set, the monitor expects exactly this value.
  flagHeader: "x-lane-enabled",
  flagValue: "1",

  // Only URLs under these origin + path prefixes are observed and rewritten.
  // `gate: true` adds a redirect to the admission page for unbound top-level
  // GET navigations, and requires a matching static deny rule in deny.json.
  targets: [
    {
      origin: "http://127.0.0.1:51843",
      pathPrefix: "/__env_probe/",
      gate: true,
    },
    {
      origin: "https://app.example.com",
      pathPrefix: "/app/",
      gate: false,
    },
  ],
};
