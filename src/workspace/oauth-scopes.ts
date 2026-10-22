/**
 * Every OAuth scope Perform requests, kept identical to `public/app-manifest.json` and
 * `OAUTH_SCOPES` in `.env.example`. Perform A/B tests paid mass messages, so it must read the
 * creator's media, audience, fan and earnings data, receive commerce events and send messages.
 */
export const performOAuthScopes = [
  "read:self", // session identity, webhook subscription
  "read:media", // Vault media for the variants
  "read:chat", // smart and custom lists, mass-message totals
  "read:fan", // list members, subscription history, Fan Insights
  "read:insights", // Fan Insights and the earnings ledger
  "read:creator", // payment, refund and dispute webhooks
  "write:chat", // per-arm custom lists and the two mass messages
] as const;
