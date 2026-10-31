// Diagnóstico: o ciclo "cadastrar novo -> recarregar" sobrevive em produção?
// Adiciona um registro de teste, relê, e SEMPRE remove no final (restaura a base).
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
  const lg = await post('/api/auth', { action: 'login', email: ADMIN, password: PASS });
  if (lg.status !== 200) { console.log('login falhou', lg.body); process.exit(1); }
  const token = lg.body.access_token;
  console.log('login OK');

  let r = await post('/api/dados', { action: 'carregar', token });
  const base = r.body.colaboradores;
  if (!Array.isArray(base)) { console.log('carregar devolveu', r.status, r.body); process.exit(1); }
  console.log('base atual: ' + base.length + ' colaboradores');
  console.log('ultimos 3: ' + base.slice(-3).map(e => e.id + ' ' + e.nome).join(' | '));

  const novoId = base.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
  const teste = { id: novoId, nome: 'ZZ TESTE DIAGNOSTICO ' + Date.now(), cargo: 'Contra-Mestre',
                  cpf: '000.000.000-00', deps: [], al: [], docs: [] };

  try {
    const sv = await post('/api/dados', { action: 'salvar', token, colaboradores: base.concat([teste]) });
    console.log('salvar novo: ' + sv.status + ' ' + JSON.stringify(sv.body));

    r = await post('/api/dados', { action: 'carregar', token });
    const depois = r.body.colaboradores;
    const achou = depois.some(e => e.id === novoId);
    console.log('reler (F5): ' + depois.length + ' colaboradores — novo registro presente? ' + achou);
  } finally {
    r = await post('/api/dados', { action: 'carregar', token });
    const limpo = (r.body.colaboradores || []).filter(e => !String(e.nome || '').startsWith('ZZ TESTE DIAGNOSTICO'));
    if (limpo.length) {
      await post('/api/dados', { action: 'salvar', token, colaboradores: limpo });
      r = await post('/api/dados', { action: 'carregar', token });
      console.log('restaurado: ' + r.body.colaboradores.length + ' colaboradores');
    }
  }
})();
