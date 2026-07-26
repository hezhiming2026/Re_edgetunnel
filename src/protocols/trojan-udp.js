const MAX_DATAGRAM_BYTES = 65_535;
const MAX_BUFFER_BYTES = 128 * 1024;

function concatBytes(left, right) {
    const joined = new Uint8Array(left.byteLength + right.byteLength);
    joined.set(left);
    joined.set(right, left.byteLength);
    return joined;
}

export class TrojanUdpDecoder {
    constructor() {
        this.buffer = new Uint8Array(0);
    }

    push(data) {
        const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (this.buffer.byteLength + chunk.byteLength > MAX_BUFFER_BYTES) {
            throw new Error('Trojan UDP buffer is too large');
        }
        this.buffer = concatBytes(this.buffer, chunk);
        const packets = [];
        let cursor = 0;
        while (cursor < this.buffer.byteLength) {
            const start = cursor;
            const addressType = this.buffer[cursor++];
            if (addressType === 1) {
                if (cursor + 4 > this.buffer.byteLength) { cursor = start; break; }
                cursor += 4;
            } else if (addressType === 4) {
                if (cursor + 16 > this.buffer.byteLength) { cursor = start; break; }
                cursor += 16;
            }
            else if (addressType === 3) {
                if (cursor >= this.buffer.byteLength) { cursor = start; break; }
                const length = this.buffer[cursor];
                if (cursor + 1 + length > this.buffer.byteLength) { cursor = start; break; }
                cursor += 1 + length;
            } else {
                throw new Error('Invalid Trojan UDP address type');
            }
            if (cursor + 6 > this.buffer.byteLength) { cursor = start; break; }
            const addressEnd = cursor + 2;
            const port = (this.buffer[cursor] << 8) | this.buffer[cursor + 1];
            const length = (this.buffer[cursor + 2] << 8) | this.buffer[cursor + 3];
            if (length > MAX_DATAGRAM_BYTES) throw new Error('Trojan UDP datagram is too large');
            if (this.buffer[cursor + 4] !== 0x0d || this.buffer[cursor + 5] !== 0x0a) {
                throw new Error('Invalid Trojan UDP delimiter');
            }
            const payloadStart = cursor + 6;
            const payloadEnd = payloadStart + length;
            if (payloadEnd > this.buffer.byteLength) { cursor = start; break; }
            packets.push({
                port,
                addressHeader: this.buffer.slice(start, addressEnd),
                payload: this.buffer.slice(payloadStart, payloadEnd),
            });
            cursor = payloadEnd;
        }
        this.buffer = this.buffer.slice(cursor);
        return packets;
    }
}

export class TrojanDnsResponseFramer {
    constructor(addressHeader) {
        this.addressHeader = new Uint8Array(addressHeader);
        this.buffer = new Uint8Array(0);
    }

    push(data) {
        const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
        this.buffer = concatBytes(this.buffer, chunk);
        const frames = [];
        while (this.buffer.byteLength >= 2) {
            const length = (this.buffer[0] << 8) | this.buffer[1];
            if (this.buffer.byteLength < length + 2) break;
            const frame = new Uint8Array(this.addressHeader.byteLength + 4 + length);
            frame.set(this.addressHeader);
            frame[this.addressHeader.byteLength] = length >> 8;
            frame[this.addressHeader.byteLength + 1] = length & 0xff;
            frame[this.addressHeader.byteLength + 2] = 0x0d;
            frame[this.addressHeader.byteLength + 3] = 0x0a;
            frame.set(this.buffer.subarray(2, 2 + length), this.addressHeader.byteLength + 4);
            frames.push(frame);
            this.buffer = this.buffer.slice(2 + length);
        }
        return frames;
    }
}

export function frameTcpDnsQuery(payload) {
    const query = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    const framed = new Uint8Array(query.byteLength + 2);
    framed[0] = query.byteLength >> 8;
    framed[1] = query.byteLength & 0xff;
    framed.set(query, 2);
    return framed;
}
