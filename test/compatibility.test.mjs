import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import semver from 'semver';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('DSH compatibility is declared at the engine path read by the host and npm catalog', () => {
  assert.equal(typeof manifest.engines.dsh, 'string');
  assert.equal(manifest.dsh.engines, undefined);
});

for (const version of ['0.1.5-rc.1', '0.1.7-rc.1', '0.2.0-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1']) {
  test(`DSH engine and model peer accept ${version}`, () => {
    assert.ok(semver.satisfies(version, manifest.engines.dsh));
    assert.ok(semver.satisfies(version, manifest.peerDependencies['@deepseek-ai/dsh-llm']));
  });
}

for (const version of ['0.1.4', '0.3.0-rc.1', '0.3.0', '1.0.0']) {
  test(`DSH engine and model peer reject ${version}`, () => {
    assert.equal(semver.satisfies(version, manifest.engines.dsh), false);
    assert.equal(semver.satisfies(version, manifest.peerDependencies['@deepseek-ai/dsh-llm']), false);
  });
}
