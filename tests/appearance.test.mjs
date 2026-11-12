import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeAppearance, timeAtmosphere, safeImage } from '../web/appearance.js';

test('外观：迁移旧背景设置，兼容布尔模糊开关并约束异常输入', () => {
  const migrated = normalizeAppearance({ mode: 'custom', zoom: 150, strength: 60, blur: false, image: 'https://example.com/wall.jpg' });
  assert.equal(migrated.blur, 0);
  assert.equal(migrated.zoom, 150);
  assert.equal(migrated.petals, 'sparse');
  assert.equal(migrated.branches, true);
  assert.equal(normalizeAppearance({ branches: false }).branches, false);
  assert.equal(normalizeAppearance({ blur: true }).blur, 3);
  const p = normalizeAppearance({ zoom: 99999, opacity: -1, wind: -999, image: 'javascript:alert(1)', material: 'invalid', speed: 'NaN' });
  assert.equal(p.zoom, 300); assert.equal(p.opacity, 75); assert.equal(p.wind, -100);
  assert.equal(p.image, ''); assert.equal(p.material, DEFAULTS.material); assert.equal(p.speed, DEFAULTS.speed);
  assert.deepEqual(normalizeAppearance(null), { ...DEFAULTS });
  assert.equal(safeImage('data:image/svg+xml;base64,PHN2Zz4='), '');
});

test('时间氛围：本地时段边界、夜间联动及固定模式', () => {
  const at = (hour, minute = 0) => new Date(2026, 10, 8, hour, minute);
  assert.equal(timeAtmosphere(at(4, 59)).key, 'night');
  assert.equal(timeAtmosphere(at(5)).key, 'dawn');
  assert.equal(timeAtmosphere(at(9)).key, 'day');
  assert.equal(timeAtmosphere(at(16)).key, 'dusk');
  assert.equal(timeAtmosphere(at(20)).key, 'night');
  assert.equal(timeAtmosphere(at(5, 59)).dark, true);
  assert.equal(timeAtmosphere(at(6)).dark, false);
  assert.equal(timeAtmosphere(at(19, 59)).dark, false);
  assert.equal(timeAtmosphere(at(23), 'day').dark, false);
  assert.equal(timeAtmosphere(at(12), 'night').dark, true);
  assert.equal(timeAtmosphere(at(23), 'off').brightness, 1);
});

test('时间氛围：色温和亮度在分段边界及午夜连续', () => {
  for (const hour of [5, 9, 16, 20, 24]) {
    const before = timeAtmosphere(new Date(2026, 10, 8, hour - 1, 59, 59));
    const after = timeAtmosphere(new Date(2026, 10, 8, hour, 0, 0));
    assert.ok(Math.abs(before.brightness - after.brightness) < .001, `brightness ${hour}`);
    assert.ok(before.rgb.every((v, i) => Math.abs(v - after.rgb[i]) <= 1), `color ${hour}`);
  }
});
