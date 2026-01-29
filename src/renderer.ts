import {
  Vec3,
  mat4Perspective, mat4LookAt, mat4Multiply,
} from "./math";
import { createMaterialTextureArray } from "./textures";
import { VERTEX_FLOATS, type WorldMesh } from "./worldmesh";

const VERTEX_STRIDE = VERTEX_FLOATS * 4; // 28 bytes

const OPAQUE_SHADER = /* wgsl */`
struct Uniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var texSampler: sampler;
@group(0) @binding(2) var texBase: texture_2d_array<f32>;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) materialIdx: f32,
};

@vertex fn vs(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) materialIdx: f32,
) -> VSOut {
  var o: VSOut;
  o.pos = u.viewProj * vec4<f32>(position, 1.0);
  o.worldPos = position;
  o.normal = normal;
  o.materialIdx = materialIdx;
  return o;
}

@fragment fn fs(v: VSOut) -> @location(0) vec4<f32> {
  let N = normalize(v.normal);
  let absN = abs(N);
  var uv: vec2<f32>;
  if (absN.y >= absN.x && absN.y >= absN.z) {
    uv = fract(v.worldPos.xz);
  } else if (absN.x >= absN.z) {
    uv = fract(v.worldPos.zy);
  } else {
    uv = fract(v.worldPos.xy);
  }

  let layer = u32(v.materialIdx + 0.5);
  let texColor = textureSample(texBase, texSampler, uv, layer);

  let sunDir = normalize(vec3<f32>(0.8, 1.0, 0.5));
  let sunColor = vec3<f32>(1.0, 0.95, 0.85);
  let backDir = normalize(vec3<f32>(-0.3, -0.2, -0.8));
  let backColor = vec3<f32>(0.5, 0.55, 0.75);

  let diffSun = max(dot(N, sunDir), 0.0);
  let diffBack = max(dot(N, backDir), 0.0);
  let diffuse = sunColor * diffSun + backColor * diffBack * 0.4;

  let viewDir = normalize(u.cameraPos - v.worldPos);
  let rim = pow(1.0 - max(dot(N, viewDir), 0.0), 3.0);
  let rimColor = vec3<f32>(0.6, 0.7, 1.0) * rim * 0.4;

  let ambient = vec3<f32>(0.08, 0.08, 0.1);
  let color = texColor.rgb * (ambient + diffuse) + rimColor;

  return vec4<f32>(color, 1.0);
}
`;

const WATER_SHADER = /* wgsl */`
struct Uniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var texSampler: sampler;
@group(0) @binding(2) var texBase: texture_2d_array<f32>;

@group(1) @binding(0) var opaqueDepthTex: texture_depth_2d;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) materialIdx: f32,
};

@vertex fn vs(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) materialIdx: f32,
) -> VSOut {
  var o: VSOut;
  o.pos = u.viewProj * vec4<f32>(position, 1.0);
  o.worldPos = position;
  o.normal = normal;
  o.materialIdx = materialIdx;
  return o;
}

@fragment fn fs(v: VSOut) -> @location(0) vec4<f32> {
  // Manual depth test against opaque geometry
  let screenUV = vec2<u32>(v.pos.xy);
  let opaqueZ = textureLoad(opaqueDepthTex, screenUV, 0);
  let fragZ = v.pos.z;
  if (fragZ > opaqueZ) {
    discard;
  }

  let N = normalize(v.normal);
  let absN = abs(N);
  var uv: vec2<f32>;
  if (absN.y >= absN.x && absN.y >= absN.z) {
    uv = fract(v.worldPos.xz);
  } else if (absN.x >= absN.z) {
    uv = fract(v.worldPos.zy);
  } else {
    uv = fract(v.worldPos.xy);
  }

  let layer = u32(v.materialIdx + 0.5);
  let texColor = textureSample(texBase, texSampler, uv, layer);

  let sunDir = normalize(vec3<f32>(0.8, 1.0, 0.5));
  let sunColor = vec3<f32>(1.0, 0.95, 0.85);
  let backDir = normalize(vec3<f32>(-0.3, -0.2, -0.8));
  let backColor = vec3<f32>(0.5, 0.55, 0.75);

  let diffSun = max(dot(N, sunDir), 0.0);
  let diffBack = max(dot(N, backDir), 0.0);
  let diffuse = sunColor * diffSun + backColor * diffBack * 0.4;

  let viewDir = normalize(u.cameraPos - v.worldPos);
  let rim = pow(1.0 - max(dot(N, viewDir), 0.0), 3.0);
  let rimColor = vec3<f32>(0.6, 0.7, 1.0) * rim * 0.4;

  let ambient = vec3<f32>(0.08, 0.08, 0.1);
  let color = texColor.rgb * (ambient + diffuse) + rimColor;

  return vec4<f32>(color, 1.0);
}
`;

const COMPOSITE_SHADER = /* wgsl */`
struct CompositeUniforms {
  nearFar: vec2<f32>,
};
@group(0) @binding(0) var<uniform> cu: CompositeUniforms;
@group(0) @binding(1) var opaqueColorTex: texture_2d<f32>;
@group(0) @binding(2) var opaqueDepthTex: texture_depth_2d;
@group(0) @binding(3) var waterColorTex: texture_2d<f32>;
@group(0) @binding(4) var waterDepthTex: texture_depth_2d;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  // Fullscreen triangle
  let x = f32(i32(vi) / 2) * 4.0 - 1.0;
  let y = f32(i32(vi) % 2) * 4.0 - 1.0;
  var o: VSOut;
  o.pos = vec4<f32>(x, y, 0.0, 1.0);
  o.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return o;
}

fn linearizeDepth(d: f32, near: f32, far: f32) -> f32 {
  // Reverse of WebGPU perspective: z_ndc = near / z_eye mapped to [0,1]
  // For standard perspective: z_ndc = (far * (z - near)) / (z * (far - near))
  // Solving for z: z = near * far / (far - d * (far - near))
  return near * far / (far - d * (far - near));
}

@fragment fn fs(v: VSOut) -> @location(0) vec4<f32> {
  let coord = vec2<u32>(v.pos.xy);
  let opaqueColor = textureLoad(opaqueColorTex, coord, 0);
  let opaqueD = textureLoad(opaqueDepthTex, coord, 0);
  let waterColor = textureLoad(waterColorTex, coord, 0);
  let waterD = textureLoad(waterDepthTex, coord, 0);

  let near = cu.nearFar.x;
  let far = cu.nearFar.y;

  // If no water was drawn at this pixel, just output opaque
  if (waterD >= 1.0) {
    return opaqueColor;
  }

  let opaqueLinZ = linearizeDepth(opaqueD, near, far);
  let waterLinZ = linearizeDepth(waterD, near, far);

  let MAX_THICKNESS = 12.0;
  let thickness = clamp((opaqueLinZ - waterLinZ) / MAX_THICKNESS, 0.0, 1.0);

  let shallowColor = vec3<f32>(0.3, 0.7, 0.8);
  let deepColor = vec3<f32>(0.05, 0.15, 0.35);
  let waterTint = mix(shallowColor, deepColor, thickness);

  let alpha = mix(0.3, 0.85, thickness);

  let finalColor = mix(opaqueColor.rgb, waterTint * waterColor.rgb, alpha);
  return vec4<f32>(finalColor, 1.0);
}
`;

export class Renderer {
  private device: GPUDevice;
  private canvasFormat: GPUTextureFormat;
  private opaquePipeline: GPURenderPipeline;
  private waterPipeline: GPURenderPipeline;
  private compositePipeline: GPURenderPipeline;
  private sharedBindGroup: GPUBindGroup;
  private uniformBuffer: GPUBuffer;
  private compositeUniformBuffer: GPUBuffer;
  private opaqueVertexBuffer: GPUBuffer;
  private opaqueIndexBuffer: GPUBuffer;
  private transparentVertexBuffer: GPUBuffer;
  private transparentIndexBuffer: GPUBuffer;
  private opaqueIndexCount: number;
  private transparentIndexCount: number;
  private depthFormat: GPUTextureFormat = "depth32float";

  // Offscreen targets (created on resize)
  private opaqueColorTex: GPUTexture | null = null;
  private opaqueDepthTex: GPUTexture | null = null;
  private waterColorTex: GPUTexture | null = null;
  private waterDepthTex: GPUTexture | null = null;
  private waterPassBindGroup: GPUBindGroup | null = null;
  private compositeBindGroup: GPUBindGroup | null = null;

  private sharedBindGroupLayout: GPUBindGroupLayout;
  private waterPassBindGroupLayout: GPUBindGroupLayout;
  private compositeBindGroupLayout: GPUBindGroupLayout;

  constructor(device: GPUDevice, format: GPUTextureFormat, mesh: WorldMesh) {
    this.device = device;
    this.canvasFormat = format;

    const opaqueModule = device.createShaderModule({ code: OPAQUE_SHADER });
    const waterModule = device.createShaderModule({ code: WATER_SHADER });
    const compositeModule = device.createShaderModule({ code: COMPOSITE_SHADER });

    this.uniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.compositeUniformBuffer = device.createBuffer({
      size: 16, // vec2<f32> padded to 16
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const { texture, sampler } = createMaterialTextureArray(device);

    // Group 0: shared (uniforms + material sampler + material texture array)
    this.sharedBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "non-filtering" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
      ],
    });

    this.sharedBindGroup = device.createBindGroup({
      layout: this.sharedBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: texture.createView({ dimension: "2d-array" }) },
      ],
    });

    // Group 1 for water pass: opaqueDepth
    this.waterPassBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d" } },
      ],
    });

    // Group 0 for composite pass: uniforms + all 4 textures
    this.compositeBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d" } },
      ],
    });

    const opaquePipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.sharedBindGroupLayout],
    });

    const waterPipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.sharedBindGroupLayout, this.waterPassBindGroupLayout],
    });

    const compositePipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.compositeBindGroupLayout],
    });

    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: VERTEX_STRIDE,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "float32x3" },
        { shaderLocation: 2, offset: 24, format: "float32" },
      ],
    };

    this.opaquePipeline = device.createRenderPipeline({
      layout: opaquePipelineLayout,
      vertex: { module: opaqueModule, entryPoint: "vs", buffers: [vertexBufferLayout] },
      fragment: { module: opaqueModule, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: { format: this.depthFormat, depthWriteEnabled: true, depthCompare: "less" },
    });

    this.waterPipeline = device.createRenderPipeline({
      layout: waterPipelineLayout,
      vertex: { module: waterModule, entryPoint: "vs", buffers: [vertexBufferLayout] },
      fragment: { module: waterModule, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: this.depthFormat, depthWriteEnabled: true, depthCompare: "less" },
    });

    this.compositePipeline = device.createRenderPipeline({
      layout: compositePipelineLayout,
      vertex: { module: compositeModule, entryPoint: "vs", buffers: [] },
      fragment: { module: compositeModule, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });

    // Upload mesh data
    this.opaqueIndexCount = mesh.opaqueIndices.length;
    this.transparentIndexCount = mesh.transparentIndices.length;

    this.opaqueVertexBuffer = this.createAndUpload(mesh.opaqueVertices, GPUBufferUsage.VERTEX);
    this.opaqueIndexBuffer = this.createAndUpload(mesh.opaqueIndices, GPUBufferUsage.INDEX);
    this.transparentVertexBuffer = this.createAndUpload(mesh.transparentVertices, GPUBufferUsage.VERTEX);
    this.transparentIndexBuffer = this.createAndUpload(mesh.transparentIndices, GPUBufferUsage.INDEX);
  }

  private createAndUpload(data: Float32Array | Uint32Array, usage: GPUFlagsConstant): GPUBuffer {
    const buf = this.device.createBuffer({
      size: Math.max(data.byteLength, 4),
      usage: usage | GPUBufferUsage.COPY_DST,
    });
    if (data.byteLength > 0) {
      this.device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
    }
    return buf;
  }

  private destroyOffscreen(): void {
    if (this.opaqueColorTex) this.opaqueColorTex.destroy();
    if (this.opaqueDepthTex) this.opaqueDepthTex.destroy();
    if (this.waterColorTex) this.waterColorTex.destroy();
    if (this.waterDepthTex) this.waterDepthTex.destroy();
  }

  destroy(): void {
    this.uniformBuffer.destroy();
    this.compositeUniformBuffer.destroy();
    this.opaqueVertexBuffer.destroy();
    this.opaqueIndexBuffer.destroy();
    this.transparentVertexBuffer.destroy();
    this.transparentIndexBuffer.destroy();
    this.destroyOffscreen();
  }

  resize(w: number, h: number) {
    this.destroyOffscreen();

    const colorUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const depthUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;

    this.opaqueColorTex = this.device.createTexture({
      size: [w, h],
      format: this.canvasFormat,
      usage: colorUsage,
    });

    this.opaqueDepthTex = this.device.createTexture({
      size: [w, h],
      format: this.depthFormat,
      usage: depthUsage,
    });

    this.waterColorTex = this.device.createTexture({
      size: [w, h],
      format: this.canvasFormat,
      usage: colorUsage,
    });

    this.waterDepthTex = this.device.createTexture({
      size: [w, h],
      format: this.depthFormat,
      usage: depthUsage,
    });

    // Recreate bind groups that reference these textures
    this.waterPassBindGroup = this.device.createBindGroup({
      layout: this.waterPassBindGroupLayout,
      entries: [
        { binding: 0, resource: this.opaqueDepthTex.createView() },
      ],
    });

    this.compositeBindGroup = this.device.createBindGroup({
      layout: this.compositeBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.compositeUniformBuffer } },
        { binding: 1, resource: this.opaqueColorTex.createView() },
        { binding: 2, resource: this.opaqueDepthTex.createView() },
        { binding: 3, resource: this.waterColorTex.createView() },
        { binding: 4, resource: this.waterDepthTex.createView() },
      ],
    });
  }

  render(context: GPUCanvasContext, camera: { yaw: number; height: number; distance: number }, aspect: number) {
    if (!this.opaqueColorTex || !this.opaqueDepthTex || !this.waterColorTex || !this.waterDepthTex) return;

    const eye: Vec3 = [
      Math.sin(camera.yaw) * camera.distance,
      camera.height,
      Math.cos(camera.yaw) * camera.distance,
    ];
    const target: Vec3 = [0, 30, 0];

    const near = 0.1;
    const far = 500;
    const fov = 60 * Math.PI / 180;
    const proj = mat4Perspective(fov, aspect, near, far);
    const view = mat4LookAt(eye, target, [0, 1, 0]);
    const viewProj = mat4Multiply(proj, view);

    this.device.queue.writeBuffer(this.uniformBuffer, 0, viewProj.buffer);
    const camBuf = new Float32Array([eye[0], eye[1], eye[2], 0]);
    this.device.queue.writeBuffer(this.uniformBuffer, 64, camBuf.buffer);

    // Write composite uniforms (near, far)
    const nearFarBuf = new Float32Array([near, far, 0, 0]);
    this.device.queue.writeBuffer(this.compositeUniformBuffer, 0, nearFarBuf.buffer);

    const commandEncoder = this.device.createCommandEncoder();

    // Pass 1: Opaque → opaqueColor + opaqueDepth
    {
      const pass = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: this.opaqueColorTex!.createView(),
          clearValue: { r: 0.53, g: 0.81, b: 0.92, a: 1.0 },
          loadOp: "clear",
          storeOp: "store",
        }],
        depthStencilAttachment: {
          view: this.opaqueDepthTex!.createView(),
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      pass.setPipeline(this.opaquePipeline);
      pass.setBindGroup(0, this.sharedBindGroup);
      pass.setVertexBuffer(0, this.opaqueVertexBuffer);
      pass.setIndexBuffer(this.opaqueIndexBuffer, "uint32");
      if (this.opaqueIndexCount > 0) {
        pass.drawIndexed(this.opaqueIndexCount);
      }
      pass.end();
    }

    // Pass 2: Water → waterColor + waterDepth
    {
      const pass = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: this.waterColorTex!.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        }],
        depthStencilAttachment: {
          view: this.waterDepthTex!.createView(),
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      pass.setPipeline(this.waterPipeline);
      pass.setBindGroup(0, this.sharedBindGroup);
      pass.setBindGroup(1, this.waterPassBindGroup!);
      pass.setVertexBuffer(0, this.transparentVertexBuffer);
      pass.setIndexBuffer(this.transparentIndexBuffer, "uint32");
      if (this.transparentIndexCount > 0) {
        pass.drawIndexed(this.transparentIndexCount);
      }
      pass.end();
    }

    // Pass 3: Composite → swapchain
    {
      const pass = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          loadOp: "clear",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: "store",
        }],
      });
      pass.setPipeline(this.compositePipeline);
      pass.setBindGroup(0, this.compositeBindGroup!);
      pass.draw(3);
      pass.end();
    }

    this.device.queue.submit([commandEncoder.finish()]);
  }
}
