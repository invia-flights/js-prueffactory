// A parse error on purpose: node --check quotes the offending line, and the
// line holds words that the .env file registers as secrets.
const config = { root: "root", realm: "confirmed" } root;
