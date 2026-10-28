// Test data may be invalid on purpose. node --check quotes the offending line,
// and that line holds a secret and the .npmrc token: redaction has to catch both.
const quoted = "ghp_9fK3mQx7TzLw2VbN8sYcR4dJhP6aEuG1oXiA" + ; // Qk4-made-up-npmrc-token-7f3a91
