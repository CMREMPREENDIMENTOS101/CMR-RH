// Teste end-to-end contra um deployment real (preview ou produção).
// Uso: node _e2e.js https://<url>
const BASE  = process.argv[2];
const ADMIN = 'contato@cmrempreendimentos.com.br';
const PASS  = 'CMR@2026';
const TESTE = '__e2e_temp@cmrempreendimentos.com.br';

// Preview deployments ficam atrás do Vercel Auth. Com ?_vercel_share=<token>
// o servidor responde um Set-Cookie que libera as chamadas seguintes.
const SHARE = process.argv[3];
let cookie = '';

async function unlock() {
  if (!SHARE) return;
  let url = BASE + '/?_vercel_share=' + SHARE;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
    const sc = r.headers.getSetCookie?.() || [];
    if (sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
    const loc = r.headers.get('location');
    if (!loc) break;
    url = new URL(loc, BASE).toString();
  }
  console.log('cookie de acesso: ' + (cookie ? 'obtido' : 'NÃO obtido'));
}

async function call(body) {
  const r = await fetch(BASE + '/api/auth', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { cookie } : {}),
    body: JSON.stringify(body)
  });
  const txt = await r.text();
  let parsed; try { parsed = JSON.parse(txt); } catch { parsed = { _raw: txt.slice(0, 200) }; }
  return { status: r.status, body: parsed };
}

(async () => {
  let fails = 0;
  const check = (label, cond, extra) => {
    console.log((cond ? '  OK   ' : '  FALHA') + ' ' + label + (extra ? '  ' + JSON.stringify(extra) : ''));
    if (!cond) fails++;
  };

  console.log('alvo: ' + BASE);
  await unlock();
  console.log('');

  console.log('1) login do admin REAL (migra CMR_USERS -> blob)');
  const login = await call({ action: 'login', email: ADMIN, password: PASS });
  check('login 200', login.status === 200, login.body);
  if (login.status !== 200) { console.log('\n>>> ABORTADO'); process.exit(1); }
  const token = login.body.access_token;
  check('nome preservado', login.body.user.name === 'CMR Admin', login.body.user);

  console.log('\n2) lista');
  const l1 = await call({ action: 'list-users', token });
  check('lista 200', l1.status === 200, l1.body);
  const antes = l1.body.users.length;
  console.log('     usuários atuais: ' + l1.body.users.map(u => u.email).join(', '));

  console.log('\n3) convite (o bug relatado)');
  const inv = await call({ action: 'invite', token, email: TESTE, name: 'E2E Temp' });
  check('invite 200', inv.status === 200, inv.body);
  if (inv.status !== 200) { console.log('\n>>> ABORTADO'); process.exit(1); }

  console.log('\n4) PERSISTIU?');
  const l2 = await call({ action: 'list-users', token });
  check('lista cresceu', l2.body.users.length === antes + 1, { antes, depois: l2.body.users.length });
  check('usuário novo presente', l2.body.users.some(u => u.email === TESTE));

  console.log('\n5) convidado entra com a senha temporária');
  const lg = await call({ action: 'login', email: TESTE, password: inv.body.tempPassword });
  check('login do convidado 200', lg.status === 200, lg.body);

  console.log('\n6) limpeza');
  const id = l2.body.users.find(u => u.email === TESTE).id;
  const del = await call({ action: 'delete-user', token, userId: id });
  check('delete 200', del.status === 200, del.body);
  const l3 = await call({ action: 'list-users', token });
  check('base voltou ao original', l3.body.users.length === antes, { antes, agora: l3.body.users.length });
  check('admin intacto', l3.body.users.some(u => u.email === ADMIN));

  console.log('\n' + (fails ? '>>> ' + fails + ' FALHA(S)' : '>>> E2E PASSOU'));
  process.exit(fails ? 1 : 0);
})();
