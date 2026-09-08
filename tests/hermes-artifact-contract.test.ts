import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactContract } from '../src/server/execution/hermes-artifact-contract';
const id='11111111-1111-4111-8111-111111111111';
test('artifact paths are scoped to each execution and text replies have no export',()=>{
 const one=artifactContract(id,1),two=artifactContract(id,2);
 assert.equal(one.parse('Olá').relativePath,undefined);
 assert.deepEqual(one.parse('Pronto. [[artifact:report.txt]]'),{text:'Pronto.',relativePath:`${id}/1/report.txt`});
 assert.notEqual(one.parse('[[artifact:report.txt]]').relativePath,two.parse('[[artifact:report.txt]]').relativePath);
});
test('artifact declaration cannot traverse, choose absolute paths or deliver multiple files',()=>{
 for(const name of ['../secret','/etc/passwd','a/b','a\\b','..','x'.repeat(81)])assert.throws(()=>artifactContract(id,1).parse(`[[artifact:${name}]]`));
 assert.throws(()=>artifactContract(id,1).parse('[[artifact:a]] [[artifact:b]]'));
 assert.throws(()=>artifactContract(id,0));
});
