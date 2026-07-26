const MAX_GRPC_FRAME_BYTES = 1024 * 1024;

function concatBytes(left, right) {
    const joined = new Uint8Array(left.byteLength + right.byteLength);
    joined.set(left);
    joined.set(right, left.byteLength);
    return joined;
}

function encodeVarint(value) {
    const bytes = [];
    let remaining = value >>> 0;
    while (remaining > 0x7f) {
        bytes.push((remaining & 0x7f) | 0x80);
        remaining >>>= 7;
    }
    bytes.push(remaining);
    return new Uint8Array(bytes);
}

function decodeHunkMessage(payload) {
    if (payload.byteLength < 2 || payload[0] !== 0x0a) return payload;
    let length = 0;
    let shift = 0;
    let cursor = 1;
    while (cursor < payload.byteLength && shift <= 28) {
        const byte = payload[cursor++];
        length |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) {
            if (length !== payload.byteLength - cursor) throw new Error('Invalid gRPC hunk length');
            return payload.subarray(cursor);
        }
        shift += 7;
    }
    throw new Error('Invalid gRPC hunk varint');
}

export function encodeGrpcHunk(data) {
    const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
    const length = encodeVarint(chunk.byteLength);
    const protobufLength = 1 + length.byteLength + chunk.byteLength;
    const frame = new Uint8Array(5 + protobufLength);
    frame[0] = 0;
    new DataView(frame.buffer).setUint32(1, protobufLength);
    frame[5] = 0x0a;
    frame.set(length, 6);
    frame.set(chunk, 6 + length.byteLength);
    return frame;
}

export class GrpcFrameDecoder {
    constructor(maxFrameBytes = MAX_GRPC_FRAME_BYTES) {
        this.buffer = new Uint8Array(0);
        this.maxFrameBytes = maxFrameBytes;
    }

    push(data) {
        const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
        this.buffer = concatBytes(this.buffer, chunk);
        const payloads = [];
        while (this.buffer.byteLength >= 5) {
            if (this.buffer[0] !== 0) throw new Error('Compressed gRPC frames are not supported');
            const length = new DataView(
                this.buffer.buffer,
                this.buffer.byteOffset + 1,
                4
            ).getUint32(0);
            if (length > this.maxFrameBytes) throw new Error('gRPC frame is too large');
            if (this.buffer.byteLength < 5 + length) break;
            payloads.push(decodeHunkMessage(this.buffer.subarray(5, 5 + length)));
            this.buffer = this.buffer.slice(5 + length);
        }
        if (this.buffer.byteLength > this.maxFrameBytes + 5) throw new Error('gRPC buffer is too large');
        return payloads;
    }
}
