export interface NativePoint {
  x: number
  y: number
}

export interface NativeBounds {
  left: number
  top: number
  right: number
  bottom: number
}

export interface NativeMatrix {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export const IDENTITY_NATIVE_MATRIX: NativeMatrix = {
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: 0,
  f: 0,
}

export function transformNativePoint(
  point: NativePoint,
  matrix: NativeMatrix,
): NativePoint {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  }
}

export function multiplyNativeMatrices(
  left: NativeMatrix,
  right: NativeMatrix,
): NativeMatrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  }
}

function cubicCoordinate(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const inverse = 1 - t
  return inverse * inverse * inverse * p0
    + 3 * inverse * inverse * t * p1
    + 3 * inverse * t * t * p2
    + t * t * t * p3
}

function quadraticRoots(a: number, b: number, c: number): number[] {
  const epsilon = 1e-12
  if (Math.abs(a) < epsilon) {
    if (Math.abs(b) < epsilon) return []
    return [-c / b]
  }
  const discriminant = b * b - 4 * a * c
  if (discriminant < -epsilon) return []
  if (Math.abs(discriminant) <= epsilon) return [-b / (2 * a)]
  const root = Math.sqrt(discriminant)
  const sign = b < 0 ? -1 : 1
  const q = -0.5 * (b + sign * root)
  if (Math.abs(q) < epsilon) {
    return [
      (-b + root) / (2 * a),
      (-b - root) / (2 * a),
    ]
  }
  return [q / a, c / q]
}

function cubicExtrema(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3
  const b = 2 * (p0 - 2 * p1 + p2)
  const c = p1 - p0
  return quadraticRoots(3 * a, 3 * b, 3 * c)
    .filter((value) => value > 0 && value < 1 && Number.isFinite(value))
}

export function exactCubicBezierBounds(
  start: NativePoint,
  control1: NativePoint,
  control2: NativePoint,
  end: NativePoint,
  matrix: NativeMatrix = IDENTITY_NATIVE_MATRIX,
): NativeBounds {
  const p0 = transformNativePoint(start, matrix)
  const p1 = transformNativePoint(control1, matrix)
  const p2 = transformNativePoint(control2, matrix)
  const p3 = transformNativePoint(end, matrix)
  const xValues = [p0.x, p3.x]
  const yValues = [p0.y, p3.y]
  for (const t of cubicExtrema(p0.x, p1.x, p2.x, p3.x)) {
    xValues.push(cubicCoordinate(p0.x, p1.x, p2.x, p3.x, t))
  }
  for (const t of cubicExtrema(p0.y, p1.y, p2.y, p3.y)) {
    yValues.push(cubicCoordinate(p0.y, p1.y, p2.y, p3.y, t))
  }
  return {
    left: Math.min(...xValues),
    top: Math.min(...yValues),
    right: Math.max(...xValues),
    bottom: Math.max(...yValues),
  }
}

export function unionNativeBounds(
  left: NativeBounds | undefined,
  right: NativeBounds | undefined,
): NativeBounds | undefined {
  if (left === undefined) return right === undefined ? undefined : { ...right }
  if (right === undefined) return { ...left }
  return {
    left: Math.min(left.left, right.left),
    top: Math.min(left.top, right.top),
    right: Math.max(left.right, right.right),
    bottom: Math.max(left.bottom, right.bottom),
  }
}

export function nativeLineBounds(
  start: NativePoint,
  end: NativePoint,
  matrix: NativeMatrix = IDENTITY_NATIVE_MATRIX,
): NativeBounds {
  const transformedStart = transformNativePoint(start, matrix)
  const transformedEnd = transformNativePoint(end, matrix)
  return {
    left: Math.min(transformedStart.x, transformedEnd.x),
    top: Math.min(transformedStart.y, transformedEnd.y),
    right: Math.max(transformedStart.x, transformedEnd.x),
    bottom: Math.max(transformedStart.y, transformedEnd.y),
  }
}

export function inflateNativeStrokeBounds(
  bounds: NativeBounds,
  width: number,
  options: Readonly<{
    miterLimit?: number
    cap?: 'butt' | 'round' | 'square'
  }> = {},
): NativeBounds {
  const half = Math.max(0, width) / 2
  const miter = Math.max(1, options.miterLimit ?? 1)
  const capScale = options.cap === 'square' ? Math.SQRT2 : 1
  const inflation = half * Math.max(miter, capScale)
  return {
    left: bounds.left - inflation,
    top: bounds.top - inflation,
    right: bounds.right + inflation,
    bottom: bounds.bottom + inflation,
  }
}

export function nativeBoundsContainPoint(
  bounds: NativeBounds,
  point: NativePoint,
): boolean {
  return point.x >= bounds.left
    && point.x <= bounds.right
    && point.y >= bounds.top
    && point.y <= bounds.bottom
}
