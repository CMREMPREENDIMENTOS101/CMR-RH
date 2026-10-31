// Harness local: exercita api/auth.js contra o Blob store real.
// Uso: node _harness.js   (não vai para o deploy — ver .vercelignore)
const fs = require('fs');

// Só precisa do token do Blob; o admin é sintetizado abaixo.
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^(BLOB_READ_WRITE_TOKEN)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

// A CLI do Vercel redige valores sensíveis no `env pull`, então CMR_USERS vem
// como "[SENSITIVE]". Monta-se aqui um admin sintético com a MESMA senha, e o
// blob de teste fica num caminho separado para não encostar na base real.
const crypto = require('crypto');
process.env.CMR_BLOB_PATH = '__harness-users.json';
process.env.CMR_JWT_SECRET = 'harness-secret';

const handler = require('./api/auth.js');

function call(body) {
  return new Promise(resolve => {
    const res = {
      _status: 200,
      setHeader() {},
      status(c) { this._status = c; return this; },
      json(o) { resolve({ status: this._status, body: o }); },
      end() { resolve({ status: this._status, body: null }); }
    };
    handler({ method: 'POST', body }, res);
  });
}

const ADMIN = 'contato@cmrempreendimentos.com.br';
const PASS  = 'CMR@2026';
const TESTE = '__harness_temp@cmrempreendimentos.com.br';

function seedEnv() {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(PASS, salt, 10000, 32, 'sha256').toString('hex');
  // schema exatamente como está gravado em produção
  const users = [{
    id: crypto.randomUUID(), email: ADMIN, name: 'CMR Admin',
    passwordHash: salt + ':' + hash, role: 'admin', createdAt: new Date().toISOString()
  }];
  process.env.CMR_USERS = Buffer.from(JSON.stringify(users)).toString('base64');
}

(async () => {
  seedEnv();
  const blob = require('@vercel/blob');
  try { await blob.del(process.env.CMR_BLOB_PATH); } catch {}
  let fails = 0;
  const check = (label, cond, extra) => {
    console.log((cond ? '  OK   ' : '  FALHA') + ' ' + label + (extra ? '  ' + JSON.stringify(extra) : ''));
    if (!cond) fails++;
  };

  console.log('\n1) login do admin (dispara a migração CMR_USERS -> blob)');
  const login = await call({ action: 'login', email: ADMIN, password: PASS });
  check('login retorna 200', login.status === 200, login.body);
  if (login.status !== 200) process.exit(1);
  const token = login.body.access_token;
  check('nome do admin preservado na migração', login.body.user.name === 'CMR Admin', login.body.user);
  check('role admin', login.body.user.role === 'admin');

  console.log('\n2) senha errada');
  const bad = await call({ action: 'login', email: ADMIN, password: 'errada' });
  check('rejeita com 401', bad.status === 401, bad.body);

  console.log('\n3) listar usuários');
  const l1 = await call({ action: 'list-users', token });
  check('lista 200', l1.status === 200, l1.body);
  const antes = l1.body.users.length;
  check('admin aparece', l1.body.users.some(u => u.email === ADMIN));
  check('hash de senha NÃO vaza', !JSON.stringify(l1.body).includes('passwordHash'));
  check('lastSignInAt preenchido pelo login', !!l1.body.users.find(u => u.email === ADMIN).lastSignInAt);

  console.log('\n4) convidar usuário — o bug original');
  const inv = await call({ action: 'invite', token, email: TESTE, name: 'Harness Temp' });
  check('invite 200', inv.status === 200, inv.body);
  const senha = inv.body.tempPassword;
  check('devolve senha temporária', !!senha);

  console.log('\n5) o usuário PERSISTIU? (leitura nova do blob)');
  const l2 = await call({ action: 'list-users', token });
  check('lista cresceu', l2.body.users.length === antes + 1, { antes, depois: l2.body.users.length });
  check('usuário novo está na lista', l2.body.users.some(u => u.email === TESTE));
  check('novo entra como "aguardando 1º acesso"', l2.body.users.find(u => u.email === TESTE).confirmedAt === null);

  console.log('\n6) o convidado consegue entrar com a senha temporária?');
  const lg2 = await call({ action: 'login', email: TESTE, password: senha });
  check('login do convidado 200', lg2.status === 200, lg2.body);
  const tokenUser = lg2.body.access_token;
  check('convidado tem role user', lg2.body.user.role === 'user');

  console.log('\n7) convidado NÃO pode administrar');
  const forbid = await call({ action: 'list-users', token: tokenUser });
  check('403 para não-admin', forbid.status === 403, forbid.body);
  const forbid2 = await call({ action: 'invite', token: tokenUser, email: 'x@y.z' });
  check('403 ao tentar convidar', forbid2.status === 403);

  console.log('\n8) status virou Ativo após o 1º acesso');
  const l3 = await call({ action: 'list-users', token });
  check('confirmedAt preenchido', !!l3.body.users.find(u => u.email === TESTE).confirmedAt);

  console.log('\n9) e-mail duplicado');
  const dup = await call({ action: 'invite', token, email: TESTE.toUpperCase() });
  check('rejeita duplicado (case-insensitive)', dup.status === 400, dup.body);

  console.log('\n10) troca de senha pelo próprio usuário');
  const chg = await call({ action: 'change-own-password', token: tokenUser, currentPassword: senha, newPassword: 'novaSenha123' });
  check('troca 200', chg.status === 200, chg.body);
  const lg3 = await call({ action: 'login', email: TESTE, password: 'novaSenha123' });
  check('entra com a senha nova', lg3.status === 200);
  const lg4 = await call({ action: 'login', email: TESTE, password: senha });
  check('senha antiga não vale mais', lg4.status === 401);

  console.log('\n11) admin reseta a senha de outro');
  const idTeste = l3.body.users.find(u => u.email === TESTE).id;
  const rst = await call({ action: 'reset-password', token, userId: idTeste });
  check('reset 200', rst.status === 200, rst.body);
  const lg5 = await call({ action: 'login', email: TESTE, password: rst.body.tempPassword });
  check('entra com a senha resetada', lg5.status === 200);

  console.log('\n12) token inválido');
  const badTok = await call({ action: 'list-users', token: token.slice(0, -3) + 'aaa' });
  check('401 com assinatura adulterada', badTok.status === 401, badTok.body);

  console.log('\n13) admin não pode ser removido');
  const idAdmin = l3.body.users.find(u => u.email === ADMIN).id;
  const delAdmin = await call({ action: 'delete-user', token, userId: idAdmin });
  check('bloqueia remoção do admin', delAdmin.status === 400, delAdmin.body);

  console.log('\n14) limpeza — remove o usuário de teste');
  const del = await call({ action: 'delete-user', token, userId: idTeste });
  check('delete 200', del.status === 200, del.body);
  const l4 = await call({ action: 'list-users', token });
  check('voltou ao estado inicial', l4.body.users.length === antes, { antes, agora: l4.body.users.length });
  check('usuário de teste sumiu', !l4.body.users.some(u => u.email === TESTE));

  try { await blob.del(process.env.CMR_BLOB_PATH); console.log('\n(blob de teste removido)'); } catch {}

  console.log('\n' + (fails ? '>>> ' + fails + ' FALHA(S)' : '>>> TODOS OS TESTES PASSARAM'));
  process.exit(fails ? 1 : 0);
})();
