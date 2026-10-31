const crypto = require('crypto');
const { put, get, list, del } = require('@vercel/blob');

const JWT_SECRET = process.env.CMR_JWT_SECRET || 'cmr-rh-secret-2026';
// Pasta de documentos do colaborador: cmr-rh-docs/<id>/. O Blob nao tem pasta de
// verdade — o arquivo marcador `.pasta` e o que diz que ela foi criada (o Blob
// recusa corpo vazio, por isso o marcador tem um texto qualquer).
const PREFIXO = 'cmr-rh-docs/';
const MARCADOR = '.pasta';
// Mesmo teto do navegador (index.html: ARQ_MAX). A funcao aceita ate 4,5 MB de payload.
const MAX_BYTES = 3 * 1024 * 1024;
const TIPOS = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', webp: 'image/webp', gif: 'image/gif'
};

// Mesma verificação de token do api/auth.js — duplicada de propósito, como no api/dados.js.
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

function pastaDe(empId) {
  const id = String(empId == null ? '' : empId);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return PREFIXO + id + '/';
}

// Caminho vindo do navegador só vale se estiver dentro da pasta daquele colaborador.
function caminhoValido(pasta, pathname) {
  const p = String(pathname || '');
  return p.startsWith(pasta) && !p.includes('..') && p.slice(pasta.length).length > 0
    && !p.slice(pasta.length).includes('/') && !p.endsWith('/' + MARCADOR);
}

function extensao(nome) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(nome || ''));
  return m ? m[1].toLowerCase() : '';
}

// Nome visível do arquivo: o pathname é <pasta><carimbo>-<nome>.
function nomeVisivel(pasta, pathname) {
  return pathname.slice(pasta.length).replace(/^\d{13}-/, '');
}

async function listarPasta(pasta) {
  const blobs = [];
  let cursor;
  do {
    const r = await list({ prefix: pasta, cursor, limit: 1000 });
    blobs.push(...r.blobs);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  const existe = blobs.some(b => b.pathname === pasta + MARCADOR);
  const arquivos = blobs
    .filter(b => b.pathname !== pasta + MARCADOR)
    .map(b => ({
      pathname: b.pathname,
      nome: nomeVisivel(pasta, b.pathname),
      tamanho: b.size,
      enviadoEm: b.uploadedAt
    }))
    .sort((a, b) => new Date(b.enviadoEm) - new Date(a.enviadoEm));
  return { existe: existe || arquivos.length > 0, arquivos };
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

  const payload = verifyJWT(body.token);
  if (!payload) return res.status(401).json({error:'Token inválido ou expirado'});

  const pasta = pastaDe(body.empId);
  if (!pasta) return res.status(400).json({error:'Colaborador inválido'});

  try {
    if (body.action === 'listar') {
      return res.status(200).json(await listarPasta(pasta));
    }

    if (body.action === 'criar-pasta') {
      await put(pasta + MARCADOR, 'pasta', {
        access: 'private', contentType: 'text/plain',
        addRandomSuffix: false, allowOverwrite: true
      });
      return res.status(200).json(await listarPasta(pasta));
    }

    if (body.action === 'upload') {
      const ext = extensao(body.nome);
      if (!TIPOS[ext]) return res.status(400).json({error:'Tipo não aceito — envie PDF ou imagem (JPG, PNG, WEBP, GIF)'});
      const dados = Buffer.from(String(body.dados || ''), 'base64');
      if (!dados.length) return res.status(400).json({error:'Arquivo vazio'});
      if (dados.length > MAX_BYTES) return res.status(413).json({error:'Arquivo acima de 3 MB'});
      // Nome limpo + carimbo de tempo: dois "RG.pdf" não se sobrescrevem.
      const base = String(body.nome).replace(/\.[^.]+$/, '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9 ._()-]/g, '_').trim().slice(0, 80) || 'arquivo';
      const pathname = pasta + Date.now() + '-' + base + '.' + ext;
      await put(pathname, dados, {
        access: 'private', contentType: TIPOS[ext],
        addRandomSuffix: false, allowOverwrite: false
      });
      // Garante a pasta mesmo se o upload vier antes do "Criar pasta".
      await put(pasta + MARCADOR, 'pasta', {
        access: 'private', contentType: 'text/plain',
        addRandomSuffix: false, allowOverwrite: true
      });
      return res.status(200).json({success:true, pathname});
    }

    if (body.action === 'baixar') {
      if (!caminhoValido(pasta, body.pathname)) return res.status(400).json({error:'Arquivo inválido'});
      const achado = await get(body.pathname, { access: 'private', useCache: false });
      if (!achado || achado.statusCode !== 200) return res.status(404).json({error:'Arquivo não encontrado'});
      const buf = Buffer.from(await new Response(achado.stream).arrayBuffer());
      return res.status(200).json({
        nome: nomeVisivel(pasta, body.pathname),
        tipo: TIPOS[extensao(body.pathname)] || 'application/octet-stream',
        dados: buf.toString('base64')
      });
    }

    if (body.action === 'excluir') {
      if (!caminhoValido(pasta, body.pathname)) return res.status(400).json({error:'Arquivo inválido'});
      await del(body.pathname);
      return res.status(200).json(await listarPasta(pasta));
    }

    return res.status(400).json({error:'Ação inválida'});
  } catch (err) {
    console.error('[arquivos]', body.action, err);
    return res.status(500).json({error:'Erro interno: '+err.message});
  }
};
