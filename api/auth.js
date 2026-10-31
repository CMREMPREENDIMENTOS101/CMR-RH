const crypto = require('crypto');
const { put, get } = require('@vercel/blob');

const JWT_SECRET = process.env.CMR_JWT_SECRET || 'cmr-rh-secret-2026';
// CMR_BLOB_PATH só é usado pelo harness de teste, para não tocar na base real.
const BLOB_PATH  = process.env.CMR_BLOB_PATH || 'cmr-users.json';

// ══════════════════════════════════════════════════════════════
// JWT
// ══════════════════════════════════════════════════════════════
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

function signJWT(payload) {
  const header = base64url(Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})));
  const body   = base64url(Buffer.from(JSON.stringify(payload)));
  const sig    = base64url(crypto.createHmac('sha256', JWT_SECRET).update(header+'.'+body).digest());
  return header+'.'+body+'.'+sig;
}

function verifyJWT(token) {
  try {
    const [h,b,s] = token.split('.');
    const expected = base64url(crypto.createHmac('sha256', JWT_SECRET).update(h+'.'+b).digest());
    if (s !== expected) return null;
    return JSON.parse(Buffer.from(b, 'base64').toString());
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
// SENHAS — PBKDF2-SHA256, formato armazenado "salt:hash"
// ══════════════════════════════════════════════════════════════
async function hashPwd(pass, salt) {
  return new Promise((res, rej) => {
    crypto.pbkdf2(pass, salt, 10000, 32, 'sha256', (e, key) => e ? rej(e) : res(key.toString('hex')));
  });
}

async function verifyPwd(pass, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const h = await hashPwd(pass, salt);
  const a = Buffer.from(h), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function newPasswordHash(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  return hashPwd(pass, salt).then(h => salt + ':' + h);
}

// ══════════════════════════════════════════════════════════════
// PERSISTÊNCIA — Vercel Blob (store privado)
// O blob é gravado com access:'private', ou seja só é legível
// com o BLOB_READ_WRITE_TOKEN — não há URL pública.
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// MÓDULOS — o que cada usuário pode abrir no sistema.
// Os ids são os mesmos que o frontend usa em showPage(id).
// `modulos: null` = acesso a tudo (usuários antigos, criados antes desta
// tela, continuam como estavam; admin sempre vê tudo).
// ══════════════════════════════════════════════════════════════
const MODULOS = ['dashboard','funcionarios','cadastro','obras','hist','holerites',
  'contratos','fichas','epi','nr','seguros','alertas','usuarios','config'];

function limpaModulos(m) {
  if (!Array.isArray(m)) return null;
  const lista = [...new Set(m.map(String).filter(x => MODULOS.includes(x)))];
  return lista.length ? lista : [];
}

// Normaliza registros antigos (schema `password` / `created`) para o atual.
function normalize(u) {
  return {
    id:            u.id || crypto.randomUUID(),
    email:         u.email,
    name:          u.name || u.email,
    passwordHash:  u.passwordHash || u.password || '',
    role:          u.role || 'user',
    modulos:       limpaModulos(u.modulos),
    createdAt:     u.createdAt || u.created || new Date().toISOString(),
    lastSignInAt:  u.lastSignInAt || null,
    confirmedAt:   u.confirmedAt || null
  };
}

// Semente: usuários que já existem na env var CMR_USERS (o admin).
function seedUsers() {
  try {
    const raw = process.env.CMR_USERS;
    if (!raw) return [];
    const arr = JSON.parse(Buffer.from(raw, 'base64').toString());
    return Array.isArray(arr) ? arr.map(normalize) : [];
  } catch { return []; }
}

// Lê a base. Se o blob ainda não existe, migra a partir de CMR_USERS.
async function readUsers() {
  // useCache:false vai direto ao storage — sem isso o CDN pode devolver
  // a versão anterior logo após um convite e o usuário "sumiria" da lista.
  const found = await get(BLOB_PATH, { access: 'private', useCache: false });
  if (!found || found.statusCode !== 200) {
    const seeded = seedUsers();
    if (seeded.length) await writeUsers(seeded);
    return seeded;
  }
  const text = await new Response(found.stream).text();
  const arr = JSON.parse(text);
  return Array.isArray(arr) ? arr.map(normalize) : [];
}

async function writeUsers(users) {
  await put(BLOB_PATH, JSON.stringify(users, null, 2), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true
  });
}

// Campos seguros para devolver ao frontend — nunca o hash.
function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, modulos: u.modulos,
    createdAt: u.createdAt, lastSignInAt: u.lastSignInAt, confirmedAt: u.confirmedAt
  };
}

// ══════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body) body = {};

  const { action } = body;

  try {
    // ── LOGIN ──
    if (action === 'login') {
      const { email, password } = body;
      if (!email || !password) return res.status(400).json({error:'Email e senha obrigatórios'});
      const users = await readUsers();
      const idx = users.findIndex(u => u.email.toLowerCase() === String(email).toLowerCase());
      if (idx === -1) return res.status(401).json({error:'Usuário não encontrado ou senha inválida'});
      const user = users[idx];
      if (!await verifyPwd(password, user.passwordHash))
        return res.status(401).json({error:'Usuário não encontrado ou senha inválida'});

      // registra o acesso — é o que faz o status virar "Ativo" na tela de Usuários
      const now = new Date().toISOString();
      users[idx].lastSignInAt = now;
      if (!users[idx].confirmedAt) users[idx].confirmedAt = now;
      await writeUsers(users);

      const token = signJWT({sub: user.id, email: user.email, role: user.role || 'user',
        modulos: user.role === 'admin' ? null : user.modulos, iat: Date.now()});
      return res.status(200).json({
        access_token: token,
        user: {id: user.id, email: user.email, name: user.name, role: user.role, modulos: user.modulos}
      });
    }

    // ── ROTAS AUTENTICADAS ──
    const token = body.token;
    if (!token) return res.status(401).json({error:'Token necessário'});
    const payload = verifyJWT(token);
    if (!payload) return res.status(401).json({error:'Token inválido ou expirado'});

    // ── TROCA DE SENHA (o próprio usuário) ──
    if (action === 'change-own-password') {
      const { currentPassword, newPassword } = body;
      if (!newPassword || String(newPassword).length < 6)
        return res.status(400).json({error:'A nova senha precisa ter ao menos 6 caracteres'});
      const users = await readUsers();
      const idx = users.findIndex(u => u.id === payload.sub);
      if (idx === -1) return res.status(404).json({error:'Usuário não encontrado'});
      if (!await verifyPwd(currentPassword, users[idx].passwordHash))
        return res.status(401).json({error:'Senha atual incorreta'});
      users[idx].passwordHash = await newPasswordHash(newPassword);
      await writeUsers(users);
      return res.status(200).json({success:true});
    }

    // ── DAQUI PARA BAIXO, SÓ ADMIN ──
    if (payload.role !== 'admin') return res.status(403).json({error:'Sem permissão'});

    // ── LISTAR ──
    if (action === 'list-users') {
      const users = await readUsers();
      return res.status(200).json({users: users.map(publicUser)});
    }

    // ── MÓDULOS DISPONÍVEIS (para a tela montar a lista) ──
    if (action === 'modulos') {
      return res.status(200).json({modulos: MODULOS});
    }

    // ── CONVIDAR ──
    if (action === 'invite') {
      const { email, name, role, modulos } = body;
      if (!email) return res.status(400).json({error:'Email obrigatório'});
      const papel = role === 'admin' ? 'admin' : 'user';
      if (papel !== 'admin' && !(Array.isArray(modulos) && limpaModulos(modulos) && limpaModulos(modulos).length))
        return res.status(400).json({error:'Selecione ao menos um módulo para o usuário'});
      const users = await readUsers();
      if (users.find(u => u.email.toLowerCase() === String(email).toLowerCase()))
        return res.status(400).json({error:'Email já cadastrado'});
      const tempPassword = crypto.randomBytes(4).toString('hex');
      const newUser = normalize({
        id: crypto.randomUUID(),
        email: String(email).trim(),
        name: name || String(email).trim(),
        passwordHash: await newPasswordHash(tempPassword),
        role: papel,
        modulos: papel === 'admin' ? null : limpaModulos(modulos),
        createdAt: new Date().toISOString()
      });
      users.push(newUser);
      await writeUsers(users);
      return res.status(200).json({success:true, tempPassword, user: publicUser(newUser)});
    }

    // ── REMOVER ──
    if (action === 'delete-user') {
      const { userId } = body;
      const users = await readUsers();
      const target = users.find(u => u.id === userId);
      if (!target) return res.status(404).json({error:'Usuário não encontrado'});
      if (target.role === 'admin') return res.status(400).json({error:'Não é possível remover o admin'});
      await writeUsers(users.filter(u => u.id !== userId));
      return res.status(200).json({success:true});
    }

    // ── MUDAR ACESSO (tipo e módulos) ──
    if (action === 'update-access') {
      const { userId, role, modulos } = body;
      const users = await readUsers();
      const idx = users.findIndex(u => u.id === userId);
      if (idx === -1) return res.status(404).json({error:'Usuário não encontrado'});
      const papel = role === 'admin' ? 'admin' : 'user';
      // o admin não pode tirar o próprio acesso de admin e ficar sem ninguém
      if (users[idx].role === 'admin' && papel !== 'admin') {
        if (users[idx].id === payload.sub) return res.status(400).json({error:'Você não pode tirar o seu próprio acesso de administrador'});
        if (users.filter(u => u.role === 'admin').length <= 1) return res.status(400).json({error:'É preciso ao menos um administrador'});
      }
      const lista = limpaModulos(modulos);
      if (papel !== 'admin' && !(lista && lista.length))
        return res.status(400).json({error:'Selecione ao menos um módulo para o usuário'});
      users[idx].role = papel;
      users[idx].modulos = papel === 'admin' ? null : lista;
      await writeUsers(users);
      return res.status(200).json({success:true, user: publicUser(users[idx])});
    }

    // ── RESETAR SENHA DE OUTRO USUÁRIO ──
    if (action === 'reset-password') {
      const { userId } = body;
      const users = await readUsers();
      const idx = users.findIndex(u => u.id === userId);
      if (idx === -1) return res.status(404).json({error:'Usuário não encontrado'});
      const tempPassword = crypto.randomBytes(4).toString('hex');
      users[idx].passwordHash = await newPasswordHash(tempPassword);
      users[idx].confirmedAt = null;
      await writeUsers(users);
      return res.status(200).json({success:true, tempPassword});
    }

    return res.status(400).json({error:'Ação inválida'});

  } catch (err) {
    console.error('[auth]', action, err);
    return res.status(500).json({error: 'Erro interno: ' + err.message});
  }
};
