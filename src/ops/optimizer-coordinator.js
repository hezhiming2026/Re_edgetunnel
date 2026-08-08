import { DurableObject } from 'cloudflare:workers';
import {
    publishAuthoritativePool,
    rollbackAuthoritativePool,
    readAuthoritativeAddTxt,
    readAuthoritativePoolStatus,
} from './pool-authority-core.js';

export class OptimizerCoordinator extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.env = env;
    }

    async mirror(result) {
        if (!result?.ok || !this.env?.KV) return 'unavailable';
        try {
            const status = readAuthoritativePoolStatus(this.ctx.storage);
            await this.env.KV.put(`optimizer:pool:${result.snapshot.revision}`, JSON.stringify(result.snapshot));
            if (status.previous) await this.env.KV.put('optimizer:previous', status.previous);
            await this.env.KV.put('optimizer:current', status.current);
            await this.env.KV.put('ADD.txt', result.add_txt);
            await this.env.KV.put('optimizer:status', JSON.stringify(status.status));
            return 'ok';
        } catch (error) {
            console.warn(`Optimizer KV mirror degraded: ${error?.message || 'unknown error'}`);
            return 'degraded';
        }
    }

    async publishPool(request) {
        const result = publishAuthoritativePool(this.ctx.storage, request);
        if (!result.ok) return result;
        const mirror = await this.mirror(result);
        return {
            ok: true,
            revision: result.revision,
            checksum: result.checksum,
            previous: result.previous,
            mirror,
        };
    }

    async rollbackPool(expectedCurrentRevision) {
        const result = rollbackAuthoritativePool(this.ctx.storage, expectedCurrentRevision);
        if (!result.ok) return result;
        const mirror = await this.mirror(result);
        return {
            ok: true,
            revision: result.revision,
            checksum: result.checksum,
            previous: result.previous,
            mirror,
        };
    }

    getStatus() {
        return readAuthoritativePoolStatus(this.ctx.storage);
    }

    getAddTxt() {
        return readAuthoritativeAddTxt(this.ctx.storage);
    }
}
