// Exercita api/dados.js contra o Blob real, num caminho de teste separado.
const fs = require('fs');
const crypto = require('crypto');

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^(BLOB_READ_WRITE_TOKEN)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.CMR_BLOB_COLAB = '__teste-colaboradores.json';
process.env.CMR_JWT_SECRET = 'segredo-de-teste';

const handler = require('./api/dados.js');

function base64url(b) { return b.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function assinar(payload) {
  const h = base64url(Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})));
  const b = base64url(Buffer.from(JSON.stringify(payload)));
  const s = base64url(crypto.createHmac('sha256', process.env.CMR_JWT_SECRET).update(h+'.'+b).digest());
  return h+'.'+b+'.'+s;
}
const TOKEN = assinar({sub:'1', email:'a@b.c', role:'admin', iat:Date.now()});

function call(body) {
  return new Promise(resolve => {
    const res = {
      _s: 200, setHeader(){}, status(c){this._s=c;return this;},
      json(o){resolve({status:this._s, body:o});}, end(){resolve({status:this._s, body:null});}
    };
    handler({method:'POST', body}, res);
  });
}

const COLAB = n => Array.from({length:n}, (_,i) => ({id:i+1, nome:'Colab '+(i+1), cargo:'Pedreiro', deps:[], al:[], docs:[]}));

(async () => {
  let fails = 0;
  const check = (l, c, x) => { console.log((c?'  OK   ':'  FALHA')+l+(x!==undefined?'  '+JSON.stringify(x):'')); if(!c) fails++; };

  const blob = require('@vercel/blob');
  try { await blob.del(process.env.CMR_BLOB_COLAB); } catch {}

  console.log('1) base ainda não existe');
  let r = await call({action:'carregar', token:TOKEN});
  check('carregar devolve null (dispara a semeadura no cliente)', r.status===200 && r.body.colaboradores===null, r.body);

  console.log('\n2) semear e reler');
  r = await call({action:'salvar', token:TOKEN, colaboradores:COLAB(8)});
  check('salvar 200', r.status===200 && r.body.total===8, r.body);
  r = await call({action:'carregar', token:TOKEN});
  check('volta com os 8', r.body.colaboradores.length===8, r.body.colaboradores&&r.body.colaboradores.length);
  check('conteúdo íntegro', r.body.colaboradores[3].nome==='Colab 4');

  console.log('\n3) leitura logo após gravação reflete na hora (o bug do cache)');
  const nove = COLAB(8).concat([{id:9,nome:'Recém-cadastrado',cargo:'Servente',deps:[],al:[],docs:[]}]);
  await call({action:'salvar', token:TOKEN, colaboradores:nove});
  r = await call({action:'carregar', token:TOKEN});
  check('o novo já aparece', r.body.colaboradores.length===9 && r.body.colaboradores[8].nome==='Recém-cadastrado', r.body.colaboradores.length);

  console.log('\n4) edição persiste');
  const editado = JSON.parse(JSON.stringify(r.body.colaboradores));
  editado[0].nome = 'Nome Editado';
  editado[0].cargo = 'Mestre de Obras';
  await call({action:'salvar', token:TOKEN, colaboradores:editado});
  r = await call({action:'carregar', token:TOKEN});
  check('nome editado gravado', r.body.colaboradores[0].nome==='Nome Editado');
  check('cargo editado gravado', r.body.colaboradores[0].cargo==='Mestre de Obras');

  console.log('\n5) exclusão persiste');
  const menos = r.body.colaboradores.filter(c => c.id !== 9);
  await call({action:'salvar', token:TOKEN, colaboradores:menos});
  r = await call({action:'carregar', token:TOKEN});
  check('sobraram 8', r.body.colaboradores.length===8);
  check('o excluído sumiu', !r.body.colaboradores.some(c=>c.id===9));

  console.log('\n6) proteções');
  r = await call({action:'carregar', token:'token.invalido.aqui'});
  check('token inválido: 401', r.status===401, r.body);
  r = await call({action:'salvar', token:TOKEN, colaboradores:'nao e array'});
  check('formato inválido: 400', r.status===400, r.body);
  r = await call({action:'salvar', token:TOKEN, colaboradores:[]});
  check('recusa apagar tudo sem confirmação: 409', r.status===409, r.body);
  r = await call({action:'carregar', token:TOKEN});
  check('base intacta após a recusa', r.body.colaboradores.length===8, r.body.colaboradores.length);
  r = await call({action:'salvar', token:TOKEN, colaboradores:[], confirmarVazio:true});
  check('esvaziar de propósito é permitido', r.status===200, r.body);
  r = await call({action:'xpto', token:TOKEN});
  check('ação desconhecida: 400', r.status===400);

  try { await blob.del(process.env.CMR_BLOB_COLAB); console.log('\n(blob de teste removido)'); } catch {}
  console.log('\n' + (fails ? '>>> '+fails+' FALHA(S)' : '>>> TODOS OS TESTES DE PERSISTÊNCIA PASSARAM'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERRO:', e); process.exit(1); });
