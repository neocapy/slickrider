import {
  Vec3,
  mat4Perspective, mat4LookAt, mat4Multiply,
} from "./math";
import { createMaterialTextureArray } from "./textures";
import { VERTEX_FLOATS, type WorldMesh } from "./worldmesh";

const VERTEX_STRIDE = VERTEX_FLOATS * 4; // 28 bytes

const SHADER_CODE = /* wgsl */`
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
  // Compute UV by projecting world position onto the face plane
  var uv: vec2<f32>;
  if (absN.y >= absN.x && absN.y >= absN.z) {
    // Y-facing: project onto XZ
    uv = fract(v.worldPos.xz);
  } else if (absN.x >= absN.z) {
    // X-facing: project onto ZY
    uv = fract(v.worldPos.zy);
  } else {
    // Z-facing: project onto XY
    uv = fract(v.worldPos.xy);
  }

  let layer = u32(v.materialIdx + 0.5);
  let texColor = textureSample(texBase, texSampler, uv, layer);

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
  let color = texColor.rgb * (ambient + diffuse) + rimColor;

  // Water (material 1) is semi-transparent
  var alpha = texColor.a;
  if (layer == 1u) {
    alpha = 0.5;
  }
  return vec4<f32>(color, alpha);
}
`;

export class Renderer {
  private device: GPUDevice;
  private opaquePipeline: GPURenderPipeline;
  private transparentPipeline: GPURenderPipeline;
  private bindGroup: GPUBindGroup;
  private uniformBuffer: GPUBuffer;
  private opaqueVertexBuffer: GPUBuffer;
  private opaqueIndexBuffer: GPUBuffer;
  private transparentVertexBuffer: GPUBuffer;
  private transparentIndexBuffer: GPUBuffer;
  private opaqueIndexCount: number;
  private transparentIndexCount: number;
  private depthTexture: GPUTexture | null = null;
  private depthFormat: GPUTextureFormat = "depth24plus";

  constructor(device: GPUDevice, format: GPUTextureFormat, mesh: WorldMesh) {
    this.device = device;

    const shaderModule = device.createShaderModule({ code: SHADER_CODE });

    this.uniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const { texture, sampler } = createMaterialTextureArray(device);

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "non-filtering" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
      ],
    });

    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: texture.createView({ dimension: "2d-array" }) },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });

    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: VERTEX_STRIDE,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },   // position
        { shaderLocation: 1, offset: 12, format: "float32x3" },  // normal
        { shaderLocation: 2, offset: 24, format: "float32" },    // materialIdx
      ],
    };

    this.opaquePipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vs", buffers: [vertexBufferLayout] },
      fragment: { module: shaderModule, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: { format: this.depthFormat, depthWriteEnabled: true, depthCompare: "less" },
    });

    this.transparentPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vs", buffers: [vertexBufferLayout] },
      fragment: {
        module: shaderModule,
        entryPoint: "fs",
        targets: [{
          format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: this.depthFormat, depthWriteEnabled: false, depthCompare: "less" },
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
      size: Math.max(data.byteLength, 4), // min 4 bytes for empty buffers
      usage: usage | GPUBufferUsage.COPY_DST,
    });
    if (data.byteLength > 0) {
      this.device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
    }
    return buf;
  }

  destroy(): void {
    this.uniformBuffer.destroy();
    this.opaqueVertexBuffer.destroy();
    this.opaqueIndexBuffer.destroy();
    this.transparentVertexBuffer.destroy();
    this.transparentIndexBuffer.destroy();
    if (this.depthTexture) this.depthTexture.destroy();
  }

  resize(w: number, h: number) {
    if (this.depthTexture) this.depthTexture.destroy();
    this.depthTexture = this.device.createTexture({
      size: [w, h],
      format: this.depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  render(context: GPUCanvasContext, camera: { yaw: number; height: number; distance: number }, aspect: number) {
    if (!this.depthTexture) return;

    const eye: Vec3 = [
      Math.sin(camera.yaw) * camera.distance,
      camera.height,
      Math.cos(camera.yaw) * camera.distance,
    ];
    const target: Vec3 = [0, 30, 0];

    const fov = 60 * Math.PI / 180;
    const proj = mat4Perspective(fov, aspect, 0.1, 500);
    const view = mat4LookAt(eye, target, [0, 1, 0]);
    const viewProj = mat4Multiply(proj, view);

    this.device.queue.writeBuffer(this.uniformBuffer, 0, viewProj.buffer);
    const camBuf = new Float32Array([eye[0], eye[1], eye[2], 0]);
    this.device.queue.writeBuffer(this.uniformBuffer, 64, camBuf.buffer);

    const commandEncoder = this.device.createCommandEncoder();
    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.53, g: 0.81, b: 0.92, a: 1.0 },
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

    // Opaque pass
    pass.setPipeline(this.opaquePipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.opaqueVertexBuffer);
    pass.setIndexBuffer(this.opaqueIndexBuffer, "uint32");
    if (this.opaqueIndexCount > 0) {
      pass.drawIndexed(this.opaqueIndexCount);
    }

    // Transparent pass
    pass.setPipeline(this.transparentPipeline);
    pass.setVertexBuffer(0, this.transparentVertexBuffer);
    pass.setIndexBuffer(this.transparentIndexBuffer, "uint32");
    if (this.transparentIndexCount > 0) {
      pass.drawIndexed(this.transparentIndexCount);
    }

    pass.end();
    this.device.queue.submit([commandEncoder.finish()]);
  }
}
