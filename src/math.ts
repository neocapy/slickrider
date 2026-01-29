// Column-major mat4 helpers for WebGPU.
// WebGPU NDC: X right, Y up, Z into screen, depth [0,1], left-handed.
// WGSL mat4x4<f32> expects column-major layout.

export type Vec3 = [number, number, number];

export function vec3Sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vec3Cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function vec3Dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vec3Scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

export function vec3Length(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

export function vec3Lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

export function vec3Normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len === 0) return [0, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function mat4Identity(): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}

// Column-major perspective for WebGPU depth [0,1].
// Right-handed view space (camera looks down -Z) → left-handed NDC.
export function mat4Perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1.0 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  // Column 0
  m[0] = f / aspect;
  // Column 1
  m[5] = f;
  // Column 2
  m[10] = far / (near - far);
  m[11] = -1;
  // Column 3
  m[14] = (near * far) / (near - far);
  return m;
}

// Right-handed lookAt. Camera at `eye` looking toward `target`, `up` is world up.
export function mat4LookAt(eye: Vec3, target: Vec3, up: Vec3): Float32Array {
  // Forward: from target to eye (camera looks down -Z in view space)
  const f = vec3Normalize(vec3Sub(target, eye)); // -Z direction
  const r = vec3Normalize(vec3Cross(f, up));      // +X
  const u = vec3Cross(r, f);                      // +Y

  const m = new Float32Array(16);
  // Column 0
  m[0] = r[0]; m[1] = u[0]; m[2] = -f[0]; m[3] = 0;
  // Column 1
  m[4] = r[1]; m[5] = u[1]; m[6] = -f[1]; m[7] = 0;
  // Column 2
  m[8] = r[2]; m[9] = u[2]; m[10] = -f[2]; m[11] = 0;
  // Column 3 (translation)
  m[12] = -vec3Dot(r, eye);
  m[13] = -vec3Dot(u, eye);
  m[14] = vec3Dot(f, eye);
  m[15] = 1;
  return m;
}

// Column-major multiply: result = a * b
export function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const r = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      r[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return r;
}
