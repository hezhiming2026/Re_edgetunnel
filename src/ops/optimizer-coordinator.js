import { DurableObject } from 'cloudflare:workers';
import {
    publishAuthoritativePool,
    rollbackAuthoritativePool,
    readAuthoritativeAddTxt,
    readAuthoritativePoolStatus,
    setManualAuthoritativeAddTxt,
} from './pool-authority-core.js';

export class OptimizerCoordinator extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.env = env;
    }

    async mirrorEffectiveAddTxt() {
        if (!this.env?.KV) return 'unavailable';
        try {
            const effectiveAddTxt = readAuthoritativeAddTxt(this.ctx.storage);
            if (effectiveAddTxt) await this.env.KV.put('ADD.txt', effectiveAddTxt);
            else if (typeof this.env.KV.delete === 'function') await this.env.KV.delete('ADD.txt');
            else await this.env.KV.put('ADD.txt', '');
            return 'ok';
        } catch (error) {
            console.warn(`Optimizer ADD.txt KV mirror degraded: ${error?.message || 'unknown error'}`);
            return 'degraded';
        }
    }

    async mirror(result) {
        if (!result?.ok || !this.env?.KV) return 'unavailable';
        try {
            const status = readAuthoritativePoolStatus(this.ctx.storage);
            await this.env.KV.put(`optimizer:pool:${result.snapshot.revision}`, JSON.stringify(result.snapshot));
            if (status.previous) await this.env.KV.put('optimizer:previous', status.previous);
            await this.env.KV.put('optimizer:current', status.current);
            const effectiveAddTxt = readAuthoritativeAddTxt(this.ctx.storage);
            if (effectiveAddTxt) await this.env.KV.put('ADD.txt', effectiveAddTxt);
            else if (typeof this.env.KV.delete === 'function') await this.env.KV.delete('ADD.txt');
            await this.env.KV.put('optimizer:status', JSON.stringify(status.status));
            return 'ok';
        } catch (error) {
            console.warn(`Optimizer KV mirror degraded: ${error?.message || 'unknown error'}`);
            return 'degraded';
        }
    }

    async publishPool(request) {
        let legacyManualAddTxt = null;
        const status = readAuthoritativePoolStatus(this.ctx.storage);
        if (!status.current && this.env?.KV) {
            legacyManualAddTxt = await this.env.KV.get('ADD.txt');
        }
        const result = publishAuthoritativePool(this.ctx.storage, request, legacyManualAddTxt);
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

    async setManualAddTxt(value) {
        const effectiveAddTxt = setManualAuthoritativeAddTxt(this.ctx.storage, value);
        await this.mirrorEffectiveAddTxt();
        return effectiveAddTxt;
    }

    getStatus() {
        return readAuthoritativePoolStatus(this.ctx.storage);
    }

    getAddTxt() {
        return readAuthoritativeAddTxt(this.ctx.storage);
    }
}
