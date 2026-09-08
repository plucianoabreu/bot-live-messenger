import test from 'node:test';
import assert from 'node:assert/strict';
import { initialAuthMode, authLinkError, signupConfirmationNotice } from '../src/components/approved/runtime.js';
test('initial account form uses signup; recovery retains login mode',()=>{assert.equal(initialAuthMode(),'signup');assert.equal(initialAuthMode({recovery:true}),'login');});
test('expired confirmation fragment overrides generic signin and ignores arbitrary descriptions',()=>{
 const message=authLinkError('?error=signin','#error=access_denied&error_code=otp_expired&error_description=UNTRUSTED');
 assert.match(message!,/inválido ou expirou/);assert.doesNotMatch(message!,/UNTRUSTED|solicite um novo link/);
 assert.equal(authLinkError('','#error_description=UNTRUSTED'),null);
 assert.equal(authLinkError('','#access_token=secret'),null);
 assert.match(authLinkError('?error_code=flow_state_expired')!,/mesmo navegador/);
});
test('successful signup has a persistent confirmation instruction for the login screen',()=>{
 assert.equal(signupConfirmationNotice(),'Confirme seu e-mail para entrar. Abra o link que enviamos e confira também a pasta de spam.');
});
