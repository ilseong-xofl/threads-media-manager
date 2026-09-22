import { describe, expect, it } from 'vitest';
import { fitCrop, integerCrop, moveCrop, resizeCrop, type CropRect, type Size } from './crop-model';

function expectInside(rect: CropRect, size: Size): void {
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(size.width + 1e-9);
  expect(rect.y + rect.height).toBeLessThanOrEqual(size.height + 1e-9);
}

describe('crop geometry', () => {
  it('keeps the full source for free or original-ratio crops', () => {
    for (const size of [
      { width: 1200, height: 800 },
      { width: 601, height: 997 },
    ]) {
      expect(fitCrop(size, null)).toEqual({ x: 0, y: 0, ...size });
      const original = fitCrop(size, size.width / size.height);
      expect(original.x).toBeCloseTo(0);
      expect(original.y).toBeCloseTo(0);
      expect(original.width).toBeCloseTo(size.width);
      expect(original.height).toBeCloseTo(size.height);
    }
  });

  it.each([
    [{ width: 1200, height: 800 }, 1, { x: 200, y: 0, width: 800, height: 800 }],
    [{ width: 1200, height: 800 }, 2, { x: 0, y: 100, width: 1200, height: 600 }],
    [{ width: 800, height: 1200 }, 0.5, { x: 100, y: 0, width: 600, height: 1200 }],
    [{ width: 800, height: 1200 }, 2, { x: 0, y: 400, width: 800, height: 400 }],
  ])('fits the largest centered rectangle in %j at ratio %s', (size, ratio, expected) => {
    expect(fitCrop(size, ratio)).toEqual(expected);
  });

  it('moves without resizing and stops independently at all image edges', () => {
    const size = { width: 1000, height: 800 };
    const rect = { x: 200, y: 100, width: 400, height: 300 };
    expect(moveCrop(rect, 15.5, -20.25, size)).toEqual({ ...rect, x: 215.5, y: 79.75 });
    expect(moveCrop(rect, -1000, -1000, size)).toEqual({ ...rect, x: 0, y: 0 });
    expect(moveCrop(rect, 1000, 1000, size)).toEqual({ ...rect, x: 600, y: 500 });
    expect(moveCrop(rect, -1000, 1000, size)).toEqual({ ...rect, x: 0, y: 500 });
    expect(moveCrop(rect, 1000, -1000, size)).toEqual({ ...rect, x: 600, y: 0 });
    expect(rect).toEqual({ x: 200, y: 100, width: 400, height: 300 });
  });

  it.each([-1, 1])('resizes on either horizontal side (%s) and both vertical sides', (sx) => {
    const size = { width: 800, height: 600 };
    const anchor = { x: 400, y: 300 };
    for (const sy of [-1, 1]) {
      const pointer = { x: anchor.x + sx * 160.5, y: anchor.y + sy * 60.25 };
      const free = resizeCrop(anchor, pointer, size, null);
      expect(free).toEqual({
        x: Math.min(anchor.x, pointer.x),
        y: Math.min(anchor.y, pointer.y),
        width: 160.5,
        height: 60.25,
      });
      const locked = resizeCrop(anchor, pointer, size, 2);
      expect(locked).toEqual({
        x: sx < 0 ? 239.5 : 400,
        y: sy < 0 ? 219.75 : 300,
        width: 160.5,
        height: 80.25,
      });
      expectInside(free, size);
      expectInside(locked, size);
    }
  });

  it('uses vertical movement for tall drags while keeping the anchor', () => {
    expect(
      resizeCrop({ x: 300, y: 200 }, { x: 290, y: 350 }, { width: 800, height: 600 }, 0.5),
    ).toEqual({ x: 225, y: 200, width: 75, height: 150 });
  });

  it('clamps out-of-image drags in all directions without shifting the anchor or ratio', () => {
    const size = { width: 800, height: 600 };
    const anchor = { x: 300, y: 200 };
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const pointer = { x: anchor.x + sx * 3000, y: anchor.y + sy * 2000 };
        for (const ratio of [null, 0.5, 1, 2]) {
          const rect = resizeCrop(anchor, pointer, size, ratio);
          expectInside(rect, size);
          expect(sx < 0 ? rect.x + rect.width : rect.x).toBeCloseTo(anchor.x);
          expect(sy < 0 ? rect.y + rect.height : rect.y).toBeCloseTo(anchor.y);
          if (ratio !== null) expect(rect.width / rect.height).toBeCloseTo(ratio);
          expect(
            rect.x === 0 ||
              rect.y === 0 ||
              rect.x + rect.width === size.width ||
              rect.y + rect.height === size.height,
          ).toBe(true);
        }
      }
    }
  });

  it('keeps zero-distance and outward edge drags positive and inside the source', () => {
    const size = { width: 800, height: 600 };
    for (const anchor of [
      { x: 0, y: 0 },
      { x: 800, y: 600 },
      { x: 200.5, y: 300.25 },
    ]) {
      for (const ratio of [null, 0.5, 1, 2]) {
        const rect = resizeCrop(anchor, anchor, size, ratio);
        expectInside(rect, size);
        if (ratio !== null) expect(rect.width / rect.height).toBeCloseTo(ratio);
      }
    }
    expect(resizeCrop({ x: 800, y: 600 }, { x: 900, y: 700 }, size, 1)).toEqual({
      x: 799,
      y: 599,
      width: 1,
      height: 1,
    });
  });

  it('rounds pixel edges rather than accumulating position and width rounding errors', () => {
    const size = { width: 800, height: 600 };
    expect(integerCrop({ x: 10.4, y: 20.6, width: 200.4, height: 100.8 }, size)).toEqual({
      x: 10,
      y: 21,
      width: 201,
      height: 100,
    });
    expect(integerCrop({ x: 799.8, y: 599.9, width: 0.2, height: 0.1 }, size)).toEqual({
      x: 799,
      y: 599,
      width: 1,
      height: 1,
    });
    expect(integerCrop({ x: -0.1, y: -0.1, width: 800.2, height: 600.2 }, size)).toEqual({
      x: 0,
      y: 0,
      ...size,
    });
  });

  it('preserves crop edges within one pixel across fractional crops and aspect ratios', () => {
    const size = { width: 997, height: 601 };
    for (const ratio of [null, size.width / size.height, 1, 4 / 3, 3 / 4, 16 / 9, 9 / 16]) {
      const rect = fitCrop(size, ratio);
      const result = integerCrop(rect, size);
      expectInside(result, size);
      expect(Object.values(result).every(Number.isInteger)).toBe(true);
      for (const key of ['x', 'y', 'width', 'height'] as const)
        expect(Math.abs(rect[key] - result[key])).toBeLessThanOrEqual(1);
    }
  });

  it('rejects nonfinite coordinates and invalid dimensions or ratios', () => {
    expect(() => fitCrop({ width: 0, height: 100 }, 1)).toThrow(RangeError);
    expect(() => fitCrop({ width: 100, height: Infinity }, 1)).toThrow(RangeError);
    for (const ratio of [0, -1, NaN, Infinity])
      expect(() => fitCrop({ width: 100, height: 100 }, ratio)).toThrow(RangeError);
    expect(() =>
      resizeCrop({ x: 0, y: 0 }, { x: NaN, y: 1 }, { width: 100, height: 100 }, null),
    ).toThrow(RangeError);
    expect(() =>
      integerCrop({ x: 0, y: 0, width: 0, height: 1 }, { width: 100, height: 100 }),
    ).toThrow(RangeError);
  });
});
