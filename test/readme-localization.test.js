import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readmes = {
    english: 'README.md',
    chinese: 'README.zh-CN.md',
    spanish: 'README.es.md',
    persian: 'README.fa.md',
};
const contents = Object.fromEntries(
    Object.entries(readmes).map(([language, filename]) => [
        language,
        fs.readFileSync(path.join(root, filename), 'utf8'),
    ]),
);

test('non-Chinese READMEs contain no Han-script text', () => {
    for (const language of ['english', 'spanish', 'persian']) {
        assert.doesNotMatch(contents[language], /\p{Script=Han}/u, `${readmes[language]} contains Han-script text`);
    }
});

test('English and Spanish READMEs contain no Arabic-script text', () => {
    for (const language of ['english', 'spanish']) {
        assert.doesNotMatch(contents[language], /\p{Script=Arabic}/u, `${readmes[language]} contains Arabic-script text`);
    }
});

test('every README links to all supported languages', () => {
    for (const [language, text] of Object.entries(contents)) {
        for (const filename of Object.values(readmes)) {
            assert.match(text, new RegExp(`href=["']${filename.replaceAll('.', '\\.')}["']`), `${readmes[language]} does not link to ${filename}`);
        }
    }
});

test('README code fences and local links are valid', () => {
    for (const [language, text] of Object.entries(contents)) {
        const fences = text.match(/^```/gm) || [];
        assert.equal(fences.length % 2, 0, `${readmes[language]} has an unclosed code fence`);

        for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
            const target = match[1].split('#')[0];
            if (!target || /^[a-z]+:/i.test(target)) continue;
            assert.equal(fs.existsSync(path.resolve(root, target)), true, `${readmes[language]} links to missing file ${target}`);
        }
    }
});
