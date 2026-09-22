export interface Size {
  width: number;
  height: number;
}

export interface CropRect extends Size {
  x: number;
  y: number;
}

type Point = { x: number; y: number };

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

function checkSize(size: Size): void {
  if (![size.width, size.height].every((value) => Number.isFinite(value) && value >= 1))
    throw new RangeError('Image dimensions must be at least one pixel');
}

function checkRatio(ratio: number | null): void {
  if (ratio !== null && (!Number.isFinite(ratio) || ratio <= 0))
    throw new RangeError('Crop ratio must be positive');
}

function checkRect(rect: CropRect): void {
  if (
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    throw new RangeError('Crop dimensions must be positive');
}

export function fitCrop(size: Size, ratio: number | null): CropRect {
  checkSize(size);
  checkRatio(ratio);
  const width = ratio === null ? size.width : Math.min(size.width, size.height * ratio);
  const height = ratio === null ? size.height : Math.min(size.height, size.width / ratio);
  return { x: (size.width - width) / 2, y: (size.height - height) / 2, width, height };
}

export function moveCrop(rect: CropRect, dx: number, dy: number, size: Size): CropRect {
  checkSize(size);
  checkRect(rect);
  if (![dx, dy].every(Number.isFinite)) throw new RangeError('Crop movement must be finite');
  const width = Math.min(rect.width, size.width);
  const height = Math.min(rect.height, size.height);
  return {
    x: clamp(rect.x + dx, 0, size.width - width),
    y: clamp(rect.y + dy, 0, size.height - height),
    width,
    height,
  };
}

export function resizeCrop(
  anchor: Point,
  pointer: Point,
  size: Size,
  ratio: number | null,
): CropRect {
  checkSize(size);
  checkRatio(ratio);
  if (![anchor.x, anchor.y, pointer.x, pointer.y].every(Number.isFinite))
    throw new RangeError('Crop coordinates must be finite');
  const x = clamp(anchor.x, 0, size.width);
  const y = clamp(anchor.y, 0, size.height);
  // At an outer edge, a zero/outward drag must still produce an inward, positive crop.
  const left = x === size.width || (pointer.x < x && x > 0);
  const up = y === size.height || (pointer.y < y && y > 0);
  const maxWidth = left ? x : size.width - x;
  const maxHeight = up ? y : size.height - y;
  const dragWidth = Math.max(0, left ? x - pointer.x : pointer.x - x);
  const dragHeight = Math.max(0, up ? y - pointer.y : pointer.y - y);
  let width = Math.min(Math.max(1, dragWidth), maxWidth);
  let height = Math.min(Math.max(1, dragHeight), maxHeight);
  if (ratio !== null) {
    // Expand along the smaller axis, then scale both axes together to fit the image.
    width = Math.min(
      Math.max(1, ratio, dragWidth, dragHeight * ratio),
      maxWidth,
      maxHeight * ratio,
    );
    height = width / ratio;
  }
  return { x: left ? x - width : x, y: up ? y - height : y, width, height };
}

export function integerCrop(rect: CropRect, size: Size): CropRect {
  checkSize(size);
  checkRect(rect);
  const maxX = Math.floor(size.width);
  const maxY = Math.floor(size.height);
  const x = clamp(Math.round(rect.x), 0, maxX - 1);
  const y = clamp(Math.round(rect.y), 0, maxY - 1);
  // Round edges together so the right/bottom boundary never exceeds the source.
  const right = clamp(Math.round(rect.x + rect.width), x + 1, maxX);
  const bottom = clamp(Math.round(rect.y + rect.height), y + 1, maxY);
  return { x, y, width: right - x, height: bottom - y };
}
