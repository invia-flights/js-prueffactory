// An error-level hit in Test code: the project's own rule no-var is an error,
// but a hit here does not say that the service is broken, so it is no Gate.
var answer = 42;

module.exports = { answer };
