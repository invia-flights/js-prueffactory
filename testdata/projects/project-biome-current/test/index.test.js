const { main } = require("../src/index.js");

function check() {
  debugger;
  return main() === 1;
}

module.exports = { check };
