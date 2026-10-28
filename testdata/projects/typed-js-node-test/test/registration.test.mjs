// The same registrations through the ES module forms of the import.
import assert from 'node:assert';
import nodeTest, { suite, it as example } from 'node:test';
import * as runner from 'node:test';

nodeTest('default import', async () => {
  assert.ok(true);
});
runner.test('namespace import', async () => {
  assert.ok(true);
});
suite('suite', () => {
  example('renamed import', async () => {
    assert.ok(true);
  });
});
