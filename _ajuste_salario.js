// Ajuste em massa de salário por cargo, pela mesma API que a tela usa.
// Uso: node _ajuste_salario.js <cargo> <novoSalario> [--aplicar]
// Sem --aplicar é simulação: mostra o que mudaria e não grava nada.
// Sempre grava um backup da base antes de qualquer escrita.
const fs = require('fs');
const path = require('path');

const BASE  = 'https://cmr-rh.vercel.app';
const ADMIN = 'contato@cmrempreendimentos.com.br';
const PASS  = 'CMR@2026';

const CARGO   = process.argv[2];
const NOVO    = process.argv[3];
const APLICAR = process.argv.includes('--aplicar');

if (!CARGO || !NOVO) { console.log('uso: node _ajuste_salario.js <cargo> <novoSalario> [--aplicar]'); process.exit(1); }
const SAL = 'R$ ' + NOVO;

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
  if (lg.status !== 200) { console.log('login falhou:', lg.body); process.exit(1); }
  const token = lg.body.access_token;

  const r = await post('/api/dados', { action: 'carregar', token });
  const base = r.body.colaboradores;
  if (!Array.isArray(base)) { console.log('não consegui ler a base:', r.status, r.body); process.exit(1); }
  console.log('base: ' + base.length + ' colaboradores');

  const arquivo = path.join(__dirname, 'backup-colaboradores-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(arquivo, JSON.stringify(base, null, 2), 'utf8');
  console.log('backup: ' + arquivo + '\n');

  const alvos = base.filter(e => String(e.cargo || '').trim().toLowerCase() === CARGO.toLowerCase());
  console.log(CARGO + ': ' + alvos.length + ' colaborador(es)');

  const mudam = alvos.filter(e => e.sal !== SAL);
  const iguais = alvos.length - mudam.length;
  const desligados = mudam.filter(e => e.desligado);

  mudam.forEach(e => console.log('  ' + (e.desligado ? '[DESLIGADO] ' : '') + e.nome.padEnd(38) + (e.sal || '—').padStart(12) + '  ->  ' + SAL));
  if (iguais) console.log('  (' + iguais + ' já estava(m) em ' + SAL + ')');
  if (desligados.length) console.log('\n  atenção: ' + desligados.length + ' desligado(s) na lista acima');

  if (!mudam.length) { console.log('\nnada a fazer.'); return; }

  if (!APLICAR) { console.log('\n>>> SIMULAÇÃO — rode de novo com --aplicar para gravar'); return; }

  const nova = base.map(e => (String(e.cargo || '').trim().toLowerCase() === CARGO.toLowerCase() ? { ...e, sal: SAL } : e));
  const sv = await post('/api/dados', { action: 'salvar', token, colaboradores: nova });
  console.log('\nsalvar: ' + sv.status + ' ' + JSON.stringify(sv.body));
  if (sv.status !== 200) { console.log('NÃO GRAVOU — base intacta.'); process.exit(1); }

  const dep = await post('/api/dados', { action: 'carregar', token });
  const conf = dep.body.colaboradores;
  const ok = conf.filter(e => String(e.cargo || '').trim().toLowerCase() === CARGO.toLowerCase() && e.sal === SAL).length;
  console.log('conferência após reler: ' + ok + '/' + alvos.length + ' com ' + SAL);
  console.log('total de colaboradores: ' + conf.length + (conf.length === base.length ? ' (inalterado)' : ' <-- MUDOU, verificar!'));
})();
