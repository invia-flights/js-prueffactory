'use strict';

// A helper in a test folder, so Test code by its place. The duplicate key is a
// real no-dupe-keys hit, and the token is made up and opens nothing.
const session = {
  user: 'tester',
  user: 'other tester',
  token: "ghp_Hn3wQ8rLx5Tz2KmB9vYc7FdS4jPa6EuR1oZk",
};

module.exports = { session };
