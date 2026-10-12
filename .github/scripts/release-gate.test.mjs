import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyRelease } from './release-gate.mjs'
const tag='v2.0.0',commit='abc'
const release={draft:false,assets:['SunYu_ERP-windows-x64.zip','SunYu_ERP-application-2.0.0.zip','SunYu_ERP-frontend-2.0.0.zip','SunYu_ERP_Upgrade.exe','update-manifest-v2.json','update-manifest.json','SHA256SUMS.txt'].map(name=>({name,state:'uploaded',size:123}))}
test('candidate is read only; invalid tags cannot reach shell arguments',()=>{assert.equal(classifyRelease('',commit,null,null),'candidate');assert.throws(()=>classifyRelease('v2; echo bad',commit,null,null))})
test('new or same-commit draft can be resumed',()=>{assert.equal(classifyRelease(tag,commit,null,null),'new');assert.equal(classifyRelease(tag,commit,null,{draft:true,target_commitish:commit}),'draft');assert.throws(()=>classifyRelease(tag,commit,null,{draft:true,target_commitish:'other'}))})
test('published complete releases skip; never overwrite foreign tags or partial releases',()=>{assert.equal(classifyRelease(tag,commit,commit,release),'published');assert.throws(()=>classifyRelease(tag,commit,'other',release));assert.throws(()=>classifyRelease(tag,commit,null,release));assert.throws(()=>classifyRelease(tag,commit,commit,{...release,assets:release.assets.slice(1)}))})
