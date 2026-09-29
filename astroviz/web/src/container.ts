/**
 * Reader for the astroviz binary container (see python/astroviz/container.py).
 * A JSON header followed by 8-byte aligned typed buffers; no dependencies.
 */

export interface ViewInfo {
  offset: number;
  length: number;
  dtype: 'float32' | 'float64' | 'int32' | 'uint8';
  shape: number[];
}

export interface Header {
  format: string;
  version: number;
  generator: string;
  meta: Record<string, unknown>;
  views: Record<string, ViewInfo>;
  datasets: DatasetRecord[];
}

/** Dataset records are plain JSON; `kind` selects the interpretation. */
export interface DatasetRecord {
  id: string;
  kind: string;
  title: string;
  [key: string]: unknown;
}

export type TypedArray = Float32Array | Float64Array | Int32Array | Uint8Array;

const MAGIC = 0x56545341; // "ASTV" little endian

export class Container {
  readonly header: Header;
  private readonly body: ArrayBuffer;
  private readonly bodyOffset: number;

  private constructor(header: Header, body: ArrayBuffer, bodyOffset: number) {
    this.header = header;
    this.body = body;
    this.bodyOffset = bodyOffset;
  }

  static parse(buffer: ArrayBuffer): Container {
    const dv = new DataView(buffer);
    if (dv.getUint32(0, true) !== MAGIC) throw new Error('not an astroviz container');
    const version = dv.getUint32(4, true);
    if (version !== 1) throw new Error(`unsupported container version ${version}`);
    const hlen = dv.getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, hlen))) as Header;
    const headEnd = 12 + hlen;
    const bodyOffset = headEnd + ((8 - (headEnd % 8)) % 8);
    return new Container(header, buffer, bodyOffset);
  }

  get datasets(): DatasetRecord[] {
    return this.header.datasets;
  }

  viewInfo(name: string): ViewInfo {
    const info = this.header.views[name];
    if (!info) throw new Error(`unknown view ${name}`);
    return info;
  }

  /** Returns a typed array over the view's bytes, zero-copy. */
  view(name: string): TypedArray {
    const info = this.viewInfo(name);
    const start = this.bodyOffset + info.offset;
    switch (info.dtype) {
      case 'float32':
        return new Float32Array(this.body, start, info.length / 4);
      case 'float64':
        return new Float64Array(this.body, start, info.length / 8);
      case 'int32':
        return new Int32Array(this.body, start, info.length / 4);
      case 'uint8':
        return new Uint8Array(this.body, start, info.length);
    }
  }

  f32(name: string): Float32Array {
    const a = this.view(name);
    return a instanceof Float32Array ? a : Float32Array.from(a as ArrayLike<number>);
  }

  f64(name: string): Float64Array {
    const a = this.view(name);
    return a instanceof Float64Array ? a : Float64Array.from(a as ArrayLike<number>);
  }
}

function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text.replace(/\s+/g, ''));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decodes a container embedded in a script tag by python/astroviz/html.py. */
export async function decodeEmbedded(el: HTMLScriptElement): Promise<ArrayBuffer> {
  const encoding = el.dataset.encoding ?? 'base64';
  const bytes = base64ToBytes(el.textContent ?? '');
  if (encoding === 'base64') return bytes.buffer;
  if (encoding === 'gzip+base64') {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('this browser lacks DecompressionStream; rebuild the page with compress=False');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }
  throw new Error(`unknown data encoding ${encoding}`);
}

/** Loads a container from an element selector (embedded) or a URL (sidecar). */
export async function loadContainer(source: string): Promise<Container> {
  if (source.startsWith('#')) {
    const el = document.querySelector<HTMLScriptElement>(source);
    if (!el) throw new Error(`no element matches ${source}`);
    return Container.parse(await decodeEmbedded(el));
  }
  const res = await fetch(source);
  if (!res.ok) throw new Error(`failed to fetch ${source}: ${res.status}`);
  return Container.parse(await res.arrayBuffer());
}
