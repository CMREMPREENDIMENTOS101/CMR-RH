const crypto = require('crypto');
const { put, get } = require('@vercel/blob');

const JWT_SECRET = process.env.CMR_JWT_SECRET || 'cmr-rh-secret-2026';
const BLOB_PATH  = process.env.CMR_BLOB_COLAB || 'cmr-colaboradores.json';
// Registro de obras do RH. Nome com prefixo `cmr-rh-` de proposito: `cmr-obras.json`
// no mesmo store pertence ao app de Controle de Obras.
const BLOB_OBRAS = process.env.CMR_BLOB_OBRAS || 'cmr-rh-obras.json';
// Efetivo diario (app de celular public/efetivo.html): registros por dia+obra e
// apelidos/nomes de mensagem. Blob proprio para nao engordar o de colaboradores.
const BLOB_EFETIVO = process.env.CMR_BLOB_EFETIVO || 'cmr-rh-efetivo.json';
// Medicao mensal da folha (aba Holerites): por competencia AAAA-MM, o que o RH
// lanca a mao (horas extras, faltas a descontar, vale transporte, observacao).
// Salario, bonus e vales vem do cadastro — aqui fica so o que muda mes a mes.
const BLOB_HOLERITES = process.env.CMR_BLOB_HOLERITES || 'cmr-rh-holerites.json';
// Sugestoes de melhoria do app (chat aberto a todos os usuarios, igual ao da
// Plataforma CMR). Respostas apontam para a sugestao por parentId.
const BLOB_SUGESTOES = process.env.CMR_BLOB_SUGESTOES || 'cmr-rh-sugestoes.json';
const STATUS_SUGESTAO = ['nova', 'analise', 'feita', 'recusada'];

// Mesma verificação de token do api/auth.js — duplicada de propósito para não
// acoplar as duas funções (mexer numa não pode derrubar o login).
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

function verifyJWT(token) {
  try {
    const [h,b,s] = String(token).split('.');
    const expected = base64url(crypto.createHmac('sha256', JWT_SECRET).update(h+'.'+b).digest());
    if (s !== expected) return null;
    return JSON.parse(Buffer.from(b, 'base64').toString());
  } catch { return null; }
}

async function lerColaboradores() {
  // useCache:false — sem isso o CDN devolve a versão anterior e uma edição
  // feita há segundos "some" ao recarregar, que é justamente o bug a evitar.
  const achado = await get(BLOB_PATH, { access: 'private', useCache: false });
  if (!achado || achado.statusCode !== 200) return null;   // null = ainda não existe
  const txt = await new Response(achado.stream).text();
  const arr = JSON.parse(txt);
  return Array.isArray(arr) ? arr : null;
}

async function lerObras() {
  const achado = await get(BLOB_OBRAS, { access: 'private', useCache: false });
  if (!achado || achado.statusCode !== 200) return null;   // null = ainda nao existe
  const txt = await new Response(achado.stream).text();
  const arr = JSON.parse(txt);
  return Array.isArray(arr) ? arr : null;
}

async function gravarObras(lista) {
  await put(BLOB_OBRAS, JSON.stringify(lista, null, 2), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true
  });
}

function efetivoVazio() {
  return { config: { apelidos: {}, obras: {} }, registros: [] };
}

async function lerEfetivo() {
  const achado = await get(BLOB_EFETIVO, { access: 'private', useCache: false });
  if (!achado || achado.statusCode !== 200) return efetivoVazio();
  const obj = JSON.parse(await new Response(achado.stream).text());
  const base = efetivoVazio();
  return {
    config: {
      apelidos: (obj.config && obj.config.apelidos) || base.config.apelidos,
      obras:    (obj.config && obj.config.obras)    || base.config.obras
    },
    registros: Array.isArray(obj.registros) ? obj.registros : []
  };
}

async function gravarEfetivo(obj) {
  await put(BLOB_EFETIVO, JSON.stringify(obj), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true
  });
}

async function lerHolerites() {
  const achado = await get(BLOB_HOLERITES, { access: 'private', useCache: false });
  if (!achado || achado.statusCode !== 200) return { competencias: {} };
  const obj = JSON.parse(await new Response(achado.stream).text());
  return { competencias: (obj && obj.competencias) || {} };
}

async function gravarHolerites(obj) {
  await put(BLOB_HOLERITES, JSON.stringify(obj), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true
  });
}

async function lerSugestoes() {
  const achado = await get(BLOB_SUGESTOES, { access: 'private', useCache: false });
  if (!achado || achado.statusCode !== 200) return [];
  const arr = JSON.parse(await new Response(achado.stream).text());
  return Array.isArray(arr) ? arr : [];
}

async function gravarSugestoes(lista) {
  await put(BLOB_SUGESTOES, JSON.stringify(lista), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true
  });
}

async function gravarColaboradores(lista) {
  await put(BLOB_PATH, JSON.stringify(lista, null, 2), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body) body = {};

  // Plataforma CMR (cmr-platform-beta, servidor a servidor): só o custo da folha
  // por obra de cada competência — totais, sem nome nem salário de ninguém.
  // Chave própria (CMR_PLATFORM_KEY, nas duas Vercel), não o login de um usuário.
  if (body.action === 'folha-por-obra') {
    const chave = String(body.chave || ''), certa = process.env.CMR_PLATFORM_KEY || '';
    const ok = certa.length >= 32 && chave.length === certa.length
      && crypto.timingSafeEqual(Buffer.from(chave), Buffer.from(certa));
    if (!ok) return res.status(401).json({error:'Chave inválida'});
    try {
      const h = await lerHolerites();
      const competencias = {};
      Object.entries(h.competencias || {}).forEach(([c, v]) => {
        competencias[c] = { salvoEm: v && v.salvoEm || null, resumoObras: v && v.resumoObras || null };
      });
      return res.status(200).json({competencias});
    } catch (err) {
      console.error('[dados] folha-por-obra', err);
      return res.status(500).json({error:'Erro interno: '+err.message});
    }
  }

  // Plataforma CMR mantém a Equipe igual ao RH (mesma chave). Só os campos que ela
  // usa — inclui a foto 3x4 (base64, já comprimida pelo RH) para os cards da Equipe;
  // sem documentos, endereço nem nomes da chamada do efetivo.
  if (body.action === 'sync-plataforma') {
    const chave = String(body.chave || ''), certa = process.env.CMR_PLATFORM_KEY || '';
    const ok = certa.length >= 32 && chave.length === certa.length
      && crypto.timingSafeEqual(Buffer.from(chave), Buffer.from(certa));
    if (!ok) return res.status(401).json({error:'Chave inválida'});
    try {
      const [colab, obras, efetivo] = await Promise.all([lerColaboradores(), lerObras(), lerEfetivo()]);
      const CAMPOS = ['id','nome','cargo','cpf','obra','adm','desligado','dtDesl','sal','bonus','vm','vc','foto'];
      const colaboradores = Array.isArray(colab) ? colab.map(e => {
        const o = {}; CAMPOS.forEach(k => { if (e && e[k] !== undefined) o[k] = e[k]; }); return o;
      }) : null;
      const registros = (efetivo && Array.isArray(efetivo.registros) ? efetivo.registros : []).map(r => ({
        data: r.data, obraId: r.obraId, obraNome: r.obraNome, parcial: !!r.parcial,
        pessoas: Array.isArray(r.pessoas) ? r.pessoas.map(p => ({presente: !!(p && p.presente)})) : [],
      }));
      const cfgObras = {};
      Object.entries((efetivo && efetivo.config && efetivo.config.obras) || {}).forEach(([k, v]) => { cfgObras[k] = {nome: v && v.nome}; });
      return res.status(200).json({
        colaboradores,
        obras: Array.isArray(obras) ? obras.map(o => ({id: o.id, nome: o.nome, desc: o.desc})) : [],
        efetivo: {registros, config: {obras: cfgObras}},
      });
    } catch (err) {
      console.error('[dados] sync-plataforma', err);
      return res.status(500).json({error:'Erro interno: '+err.message});
    }
  }

  const payload = verifyJWT(body.token);
  if (!payload) return res.status(401).json({error:'Token inválido ou expirado'});

  // Holerites tem dado sensível (salários): além de sumir do menu, o servidor
  // recusa quem não tem o módulo liberado na tela de Usuários. Token antigo,
  // sem a lista de módulos, segue funcionando como antes.
  if (/-holerites$/.test(String(body.action || '')) && payload.role !== 'admin'
      && Array.isArray(payload.modulos) && !payload.modulos.includes('holerites'))
    return res.status(403).json({error:'Sem acesso ao módulo Holerites'});

  try {
    if (body.action === 'carregar') {
      const colaboradores = await lerColaboradores();
      return res.status(200).json({colaboradores});
    }

    if (body.action === 'salvar') {
      const lista = body.colaboradores;
      if (!Array.isArray(lista))
        return res.status(400).json({error:'Formato inválido: esperado um array de colaboradores'});
      // Guarda contra um bug de frontend zerar a base inteira sem querer.
      if (lista.length === 0 && body.confirmarVazio !== true) {
        const atual = await lerColaboradores();
        if (atual && atual.length > 0)
          return res.status(409).json({error:'Recusado: gravaria uma lista vazia por cima de '+atual.length+' colaborador(es)'});
      }
      await gravarColaboradores(lista);
      return res.status(200).json({success:true, total:lista.length});
    }

    if (body.action === 'carregar-obras') {
      const obras = await lerObras();
      return res.status(200).json({obras});
    }

    if (body.action === 'salvar-obras') {
      const lista = body.obras;
      if (!Array.isArray(lista))
        return res.status(400).json({error:'Formato inválido: esperado um array de obras'});
      await gravarObras(lista);
      return res.status(200).json({success:true, total:lista.length});
    }

    if (body.action === 'carregar-efetivo') {
      const efetivo = await lerEfetivo();
      return res.status(200).json({efetivo});
    }

    // Grava UM dia de UMA obra (e/ou um trecho de config). A mescla e feita aqui,
    // relendo o blob, para dois encarregados salvando obras diferentes ao mesmo
    // tempo nao apagarem o registro um do outro.
    if (body.action === 'salvar-efetivo') {
      const atual = await lerEfetivo();
      const r = body.registro;
      if (r) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.data || '')) || r.obraId == null || !Array.isArray(r.pessoas))
          return res.status(400).json({error:'Registro inválido: data, obraId e pessoas são obrigatórios'});
        const reg = Object.assign({}, r, {
          obraId: String(r.obraId),
          salvoEm: new Date().toISOString(),
          salvoPor: payload.email || ''
        });
        const i = atual.registros.findIndex(x => x.data === reg.data && String(x.obraId) === reg.obraId);
        if (i >= 0) atual.registros[i] = reg; else atual.registros.push(reg);
      }
      if (body.removerRegistro) {
        const {data, obraId} = body.removerRegistro;
        atual.registros = atual.registros.filter(x => !(x.data === data && String(x.obraId) === String(obraId)));
      }
      const c = body.config;
      if (c && typeof c === 'object') {
        if (c.apelidos && typeof c.apelidos === 'object') {
          for (const [k, v] of Object.entries(c.apelidos)) {
            if (v) atual.config.apelidos[k] = String(v); else delete atual.config.apelidos[k];
          }
        }
        if (c.obras && typeof c.obras === 'object') {
          for (const [k, v] of Object.entries(c.obras)) {
            if (v) atual.config.obras[k] = v; else delete atual.config.obras[k];
          }
        }
      }
      await gravarEfetivo(atual);
      return res.status(200).json({success:true, efetivo: atual});
    }

    if (body.action === 'carregar-holerites') {
      const holerites = await lerHolerites();
      return res.status(200).json({holerites});
    }

    // Grava a medicao de UMA competencia, relendo o blob: salvar setembro nao
    // pode apagar o agosto que outra pessoa fechou.
    if (body.action === 'salvar-holerites') {
      const comp = String(body.competencia || '');
      const dados = body.dados;
      if (!/^\d{4}-\d{2}$/.test(comp) || !dados || typeof dados !== 'object' || typeof dados.linhas !== 'object')
        return res.status(400).json({error:'Medição inválida: competência AAAA-MM e linhas são obrigatórias'});
      const atual = await lerHolerites();
      atual.competencias[comp] = Object.assign({}, dados, {
        salvoEm: new Date().toISOString(),
        salvoPor: payload.email || ''
      });
      await gravarHolerites(atual);
      return res.status(200).json({success:true, holerites: atual});
    }

    if (body.action === 'carregar-sugestoes') {
      return res.status(200).json({sugestoes: await lerSugestoes()});
    }

    // Toda escrita relê o blob antes de gravar: duas pessoas mandando ao mesmo
    // tempo nao apagam a mensagem uma da outra. O autor sai do token, nao do navegador.
    if (body.action === 'enviar-sugestao') {
      const s = body.sugestao || {};
      const mensagem = String(s.mensagem || '').trim().slice(0, 2000);
      const painel = String(s.painel || '').trim().slice(0, 60);
      const card = String(s.card || '').trim().slice(0, 80);
      if (!mensagem || !painel || !card)
        return res.status(400).json({error:'Sugestão inválida: painel, card e mensagem são obrigatórios'});
      const lista = await lerSugestoes();
      // Print opcional: so JPEG em data URL (o navegador ja reduz), ate ~700 KB.
      let imagem = null;
      if (s.imagem) {
        imagem = String(s.imagem);
        if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(imagem) || imagem.length > 750000)
          return res.status(400).json({error:'Imagem inválida ou grande demais'});
      }
      const parentId = s.parentId ? String(s.parentId) : null;
      if (parentId && !lista.some(x => x.id === parentId && !x.parentId))
        return res.status(400).json({error:'A sugestão respondida não existe mais'});
      const nova = {
        id: crypto.randomUUID(), parentId, painel, card, mensagem, imagem,
        autorNome: String(s.autorNome || '').trim().slice(0, 80) || payload.email,
        autorEmail: String(payload.email || '').toLowerCase(),
        status: 'nova', criadoEm: new Date().toISOString()
      };
      lista.push(nova);
      await gravarSugestoes(lista);
      return res.status(200).json({success:true, sugestao: nova});
    }

    if (body.action === 'status-sugestao') {
      if (payload.role !== 'admin') return res.status(403).json({error:'Só admin muda o status'});
      if (!STATUS_SUGESTAO.includes(body.status)) return res.status(400).json({error:'Status inválido'});
      const lista = await lerSugestoes();
      const s = lista.find(x => x.id === String(body.id));
      if (!s) return res.status(404).json({error:'Sugestão não encontrada'});
      s.status = body.status;
      await gravarSugestoes(lista);
      return res.status(200).json({success:true});
    }

    // Excluir: o proprio autor ou admin. Sugestao leva as respostas junto.
    if (body.action === 'excluir-sugestao') {
      const lista = await lerSugestoes();
      const id = String(body.id);
      const s = lista.find(x => x.id === id);
      if (!s) return res.status(200).json({success:true});
      if (payload.role !== 'admin' && s.autorEmail !== String(payload.email || '').toLowerCase())
        return res.status(403).json({error:'Só o autor ou um admin pode excluir'});
      await gravarSugestoes(lista.filter(x => x.id !== id && x.parentId !== id));
      return res.status(200).json({success:true});
    }

    return res.status(400).json({error:'Ação inválida'});

  } catch (err) {
    console.error('[dados]', body.action, err);
    return res.status(500).json({error:'Erro interno: '+err.message});
  }
};
