// Keep development proxy and service-worker exclusions together. Auth API routes
// already sit under the API prefix; explicit callback prefixes stay reserved too.
export const backendPaths = [
  /^\/api(?:[/?]|$)/,
  /^\/health(?:[/?]|$)/,
  /^\/ready(?:[/?]|$)/,
  /^\/auth(?:[/?]|$)/,
  /^\/oidc(?:[/?]|$)/,
];
