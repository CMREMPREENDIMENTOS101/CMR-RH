// Ciclo real contra produção: login -> ler -> editar -> reler (como um F5).
const BASE  = process.argv[2] || 'https://cmr-rh.vercel.app';
const ADMIN = 'contato@cmrempreendimentos.com.br';
const PASS  = 'CMR@2026';

async function post(rota, body) {
  const r = await fetch(BASE + rota, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const t = await r.text();
  let p; try { p = JSON.parse(t); } catch { p = { _raw: t.slice(0, 200) }; }
  return { status: r.status, body: p };
}

(async () => {
  let fails = 0;
  const check = (l, c, x) => { console.log((c?'  OK   ':'  FALHA')+l+(x!==undefined?'  '+JSON.stringify(x):'')); if(!c) fails++; };
  console.log('alvo: ' + BASE + '\n');

  console.log('1) login');
  const lg = await post('/api/auth', { action:'login', email:ADMIN, password:PASS });
  check('login 200', lg.status===200, lg.body);
  if (lg.status !== 200) process.exit(1);
  const token = lg.body.access_token;

  console.log('\n2) estado atual da base');
  let r = await post('/api/dados', { action:'carregar', token });
  check('carregar 200', r.status===200, r.status);
  const inicial = r.body.colaboradores;
  console.log('     ' + (inicial===null ? 'base ainda vazia (será semeada no 1º acesso pela tela)' : inicial.length + ' colaboradores gravados'));

  // NUNCA semear daqui: gravar um registro de teste substituiria a base real
  // que a tela usa. Se ainda estiver vazia, é só abrir o app uma vez.
  const base = inicial;
  if (base === null) {
    console.log('\n>>> base ainda não semeada — abra https://cmr-rh.vercel.app uma vez e repita');
    process.exit(1);
  }

  console.log('\n3) editar o primeiro colaborador');
  const nomeOriginal = base[0].nome;
  const marca = 'E2E ' + Date.now();
  const editado = JSON.parse(JSON.stringify(base));
  editado[0].nome = marca;
  const sv = await post('/api/dados', { action:'salvar', token, colaboradores: editado });
  check('salvar 200', sv.status===200, sv.body);

  console.log('\n4) "recarregar a página" — nova leitura do zero');
  r = await post('/api/dados', { action:'carregar', token });
  check('a edição sobreviveu', r.body.colaboradores[0].nome === marca, r.body.colaboradores[0].nome);
  check('total inalterado', r.body.colaboradores.length === base.length);

  console.log('\n5) restaurar o nome original');
  const volta = JSON.parse(JSON.stringify(r.body.colaboradores));
  volta[0].nome = nomeOriginal;
  await post('/api/dados', { action:'salvar', token, colaboradores: volta });
  r = await post('/api/dados', { action:'carregar', token });
  check('restaurado', r.body.colaboradores[0].nome === nomeOriginal, r.body.colaboradores[0].nome);

  console.log('\n6) proteções em produção');
  r = await post('/api/dados', { action:'carregar', token:'aa.bb.cc' });
  check('sem token válido: 401', r.status===401, r.body);
  r = await post('/api/dados', { action:'salvar', token, colaboradores: [] });
  check('recusa esvaziar a base', r.status===409, r.body);
  r = await post('/api/dados', { action:'carregar', token });
  check('base intacta depois da recusa', r.body.colaboradores.length === base.length, r.body.colaboradores.length);

  console.log('\n7) o login continua funcionando (auth intacto)');
  const lg2 = await post('/api/auth', { action:'list-users', token });
  check('list-users 200', lg2.status===200, lg2.status);

  console.log('\n' + (fails ? '>>> '+fails+' FALHA(S)' : '>>> E2E DE PERSISTÊNCIA PASSOU'));
  process.exit(fails ? 1 : 0);
})();
