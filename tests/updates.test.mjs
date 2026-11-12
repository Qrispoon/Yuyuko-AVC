import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { RELEASE_HISTORY, CURRENT_RELEASE } from '../web/updates.js';

test('更新日志：按新到旧覆盖全部发布版本，版本与日期同发布源一致', async () => {
  const [changelog, packageText] = await Promise.all([
    fs.readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);
  const published = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})/gm)];
  const timelineVersions = RELEASE_HISTORY.map(release => release.version);
  assert.deepEqual(timelineVersions, published.map(match => match[1]), '更新日志必须按新到旧逐版列出，不能遗漏或重复');
  assert.equal(CURRENT_RELEASE, JSON.parse(packageText).version);
  for (const release of RELEASE_HISTORY) {
    assert.equal(release.date, published.find(match => match[1] === release.version)[2]);
  }
});
