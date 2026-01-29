import {
  Vec3, vec3Sub, vec3Cross, vec3Normalize,
  mat4Perspective, mat4LookAt, mat4Multiply,
} from "./math";

const VERTEX_STRIDE = 32; // bytes: 3 pos + 3 normal + 2 uv = 8 floats

const SHADER_CODE = /* wgsl */`
struct Uniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var texSampler: sampler;
@group(0) @binding(2) var texBase: texture_2d<f32>;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
};

@vertex fn vs(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
) -> VSOut {
  var o: VSOut;
  o.pos = u.viewProj * vec4<f32>(position, 1.0);
  o.worldPos = position;
  o.normal = normal;
  o.uv = uv;
  return o;
}

@fragment fn fs(v: VSOut) -> @location(0) vec4<f32> {
  let N = normalize(v.normal);
  let texColor = textureSample(texBase, texSampler, v.uv).rgb;

  // Two directional lights
  let sunDir = normalize(vec3<f32>(0.8, 1.0, 0.5));
  let sunColor = vec3<f32>(1.0, 0.95, 0.85);
  let backDir = normalize(vec3<f32>(-0.3, -0.2, -0.8));
  let backColor = vec3<f32>(0.5, 0.55, 0.75);

  let diffSun = max(dot(N, sunDir), 0.0);
  let diffBack = max(dot(N, backDir), 0.0);
  let diffuse = sunColor * diffSun + backColor * diffBack * 0.4;

  // Rim lighting (Fresnel)
  let viewDir = normalize(u.cameraPos - v.worldPos);
  let rim = pow(1.0 - max(dot(N, viewDir), 0.0), 3.0);
  let rimColor = vec3<f32>(0.6, 0.7, 1.0) * rim * 0.4;

  let ambient = vec3<f32>(0.08, 0.08, 0.1);
  let color = texColor * (ambient + diffuse) + rimColor;
  return vec4<f32>(color, 1.0);
}
`;

export class Renderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private bindGroup: GPUBindGroup;
  private uniformBuffer: GPUBuffer;
  private vertexBuffer: GPUBuffer;
  private indexBuffer: GPUBuffer;
  private depthTexture: GPUTexture | null = null;
  private depthFormat: GPUTextureFormat = "depth24plus";

  // Draw call info: [indexCount, firstIndex, baseVertex]
  private draws: [number, number, number][] = [];

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;

    const shaderModule = device.createShaderModule({ code: SHADER_CODE });

    // Uniform buffer: mat4 (64 bytes) + vec3 padded to vec4 (16 bytes) = 80 bytes
    // Align to 256 for WebGPU uniform buffer offset alignment (safe default)
    this.uniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Test texture 16x16
    const { texture, sampler } = this.createTestTexture();

    // Bind group layout
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });

    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: texture.createView() },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });

    this.pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs",
        buffers: [{
          arrayStride: VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },  // position
            { shaderLocation: 1, offset: 12, format: "float32x3" }, // normal
            { shaderLocation: 2, offset: 24, format: "float32x2" }, // uv
          ],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs",
        targets: [{ format }],
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none",
      },
      depthStencil: {
        format: this.depthFormat,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    // Build geometry
    const { vertexData, indexData, draws } = this.buildScene();
    this.draws = draws;

    this.vertexBuffer = device.createBuffer({
      size: vertexData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vertexBuffer, 0, vertexData.buffer);

    this.indexBuffer = device.createBuffer({
      size: indexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indexBuffer, 0, indexData.buffer);
  }

  resize(w: number, h: number) {
    if (this.depthTexture) this.depthTexture.destroy();
    this.depthTexture = this.device.createTexture({
      size: [w, h],
      format: this.depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  render(context: GPUCanvasContext, time: number, aspect: number) {
    if (!this.depthTexture) return;

    // Camera orbit
    const angle = time * 0.3;
    const radius = 6;
    const elevation = 25 * Math.PI / 180;
    const cy = Math.sin(elevation) * radius;
    const cxz = Math.cos(elevation) * radius;
    const eye: Vec3 = [Math.sin(angle) * cxz, cy, Math.cos(angle) * cxz];
    const target: Vec3 = [0, 1.5, 0];

    const fov = 60 * Math.PI / 180;
    const proj = mat4Perspective(fov, aspect, 0.1, 100);
    const view = mat4LookAt(eye, target, [0, 1, 0]);
    const viewProj = mat4Multiply(proj, view);

    // Upload uniforms: viewProj (64 bytes) then cameraPos (12 bytes at offset 64)
    this.device.queue.writeBuffer(this.uniformBuffer, 0, viewProj.buffer);
    const camBuf = new Float32Array([eye[0], eye[1], eye[2], 0]);
    this.device.queue.writeBuffer(this.uniformBuffer, 64, camBuf.buffer);

    const commandEncoder = this.device.createCommandEncoder();
    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.05, g: 0.0, b: 0.1, a: 1.0 },
        loadOp: "clear",
        storeOp: "store",
      }],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, "uint16");

    for (const [indexCount, firstIndex, baseVertex] of this.draws) {
      pass.drawIndexed(indexCount, 1, firstIndex, baseVertex);
    }

    pass.end();
    this.device.queue.submit([commandEncoder.finish()]);
  }

  private createTestTexture(): { texture: GPUTexture; sampler: GPUSampler } {
    const size = 16;
    const data = new Uint8Array(size * size * 4);

    // Two shades of slate blue for checkerboard
    // HSL(220, 20%, 40%) ≈ RGB(82, 92, 122)
    // HSL(220, 20%, 35%) ≈ RGB(71, 80, 107)
    const light: [number, number, number] = [82, 92, 122];
    const dark: [number, number, number] = [71, 80, 107];

    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        const i = (row * size + col) * 4;
        const checker = (row + col) % 2 === 0;
        const base = checker ? light : dark;

        // UV tint: red increases with U (col), green increases with V (row)
        // Converges at top-left (0,0) = minimal tint
        const uTint = col / 15; // 0..1
        const vTint = row / 15; // 0..1

        data[i + 0] = Math.min(255, base[0] + Math.round(uTint * 40)); // R + red tint
        data[i + 1] = Math.min(255, base[1] + Math.round(vTint * 40)); // G + green tint
        data[i + 2] = base[2];
        data[i + 3] = 255;
      }
    }

    const texture = this.device.createTexture({
      size: [size, size],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture },
      data,
      { bytesPerRow: size * 4 },
      [size, size],
    );

    const sampler = this.device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
    });

    return { texture, sampler };
  }

  private buildScene(): {
    vertexData: Float32Array;
    indexData: Uint16Array;
    draws: [number, number, number][];
  } {
    const verts: number[] = [];
    const indices: number[] = [];
    const draws: [number, number, number][] = [];

    let vertexOffset = 0;
    let indexOffset = 0;

    // --- 30 Random Triangles (flat shaded) ---
    // Use a seeded-ish approach with Math.random for reproducibility isn't needed
    const triVertCount = 30 * 3;
    for (let t = 0; t < 30; t++) {
      const p0: Vec3 = [rand(-2, 2), rand(-2, 2), rand(-2, 2)];
      const p1: Vec3 = [rand(-2, 2), rand(-2, 2), rand(-2, 2)];
      const p2: Vec3 = [rand(-2, 2), rand(-2, 2), rand(-2, 2)];

      const edge1 = vec3Sub(p1, p0);
      const edge2 = vec3Sub(p2, p0);
      const normal = vec3Normalize(vec3Cross(edge1, edge2));

      for (const p of [p0, p1, p2]) {
        verts.push(p[0], p[1], p[2]);
        verts.push(normal[0], normal[1], normal[2]);
        verts.push(Math.random(), Math.random()); // random UV
      }
      indices.push(vertexOffset, vertexOffset + 1, vertexOffset + 2);
      vertexOffset += 3;
    }
    draws.push([triVertCount, indexOffset, 0]);
    indexOffset += triVertCount;

    // --- Cylinder (smooth shaded, no caps) ---
    const segments = 24;
    const cylRadius = 0.8;
    const cylHeight = 1.5;
    const cylY = 3.5; // hover above triangles
    const cylBaseVertex = vertexOffset;

    // 2 rings: bottom and top
    for (let ring = 0; ring < 2; ring++) {
      const y = cylY + (ring === 0 ? -cylHeight / 2 : cylHeight / 2);
      for (let seg = 0; seg < segments; seg++) {
        const theta = (seg / segments) * Math.PI * 2;
        const x = Math.cos(theta) * cylRadius;
        const z = Math.sin(theta) * cylRadius;
        // Position
        verts.push(x, y, z);
        // Normal: radial outward (smooth — shared across rings at same angle)
        const n = vec3Normalize([x, 0, z]);
        verts.push(n[0], n[1], n[2]);
        // UV: u = seg/segments, v = ring
        verts.push(seg / segments, ring);
      }
    }
    vertexOffset += segments * 2;

    // Indices for cylinder quads
    const cylIndexStart = indexOffset;
    for (let seg = 0; seg < segments; seg++) {
      const next = (seg + 1) % segments;
      const bottom = cylBaseVertex + seg;
      const top = cylBaseVertex + segments + seg;
      const bottomNext = cylBaseVertex + next;
      const topNext = cylBaseVertex + segments + next;

      // Two triangles per quad
      indices.push(bottom, bottomNext, top);
      indices.push(bottomNext, topNext, top);
      indexOffset += 6;
    }
    draws.push([segments * 6, cylIndexStart, 0]);

    return {
      vertexData: new Float32Array(verts),
      indexData: new Uint16Array(indices),
      draws,
    };
  }
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
