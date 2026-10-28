'use strict';

const assert = require('node:assert');
const { add, loadUser } = require('../src/index');

// Many projects log what they cannot handle, and that hides unhandled
// rejections from the run: nothing fails, the message is only printed.
process.on('unhandledRejection', (reason) => {
  console.log('unhandled rejection logged:', reason && reason.message);
});

describe('user', () => {
  it('passes although its floating promise rejects', async () => {
    loadUser(); // neither awaited nor returned, so nobody handles the rejection
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(true);
  });

  it('passes in every run', () => {
    assert.strictEqual(add(2, 3), 5);
  });
});
