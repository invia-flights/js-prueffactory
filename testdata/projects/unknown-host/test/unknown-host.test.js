'use strict';

const http = require('node:http');

// The Run provides no host named not-a-service. The request must fail with a
// lookup error, not run into the 5 s Mocha timeout below.
describe('a host the Run does not provide', function () {
  this.timeout(5000);

  it('is requested', (done) => {
    http
      .get('http://not-a-service:9000/', { timeout: 5000 }, () => done())
      .on('error', done);
  });
});
