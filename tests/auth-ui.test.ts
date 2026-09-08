import test from 'node:test';
import assert from 'node:assert/strict';
import { initialAuthMode } from '../src/components/approved/runtime.js';
test('initial account form uses signup; recovery retains login mode',()=>{assert.equal(initialAuthMode(),'signup');assert.equal(initialAuthMode({recovery:true}),'login');});
