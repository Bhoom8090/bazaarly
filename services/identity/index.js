'use strict';
// Identity service: users, auth (JWT in HttpOnly cookie), addresses, admin MFA.
require('../../shared/telemetry');
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const { z } = require('zod');
const config = require('../../shared/config');
const logger = require('../../shared/logger');
const cookieParser = require('cookie-parser');
const { createApp, finish, listen, asyncH, validate, requireUser, HttpError } = require('../../shared/http');
const { connectDb, withTxn, TxnAbort, ensureEventTables } = require('../../shared/db');

const app = createApp('identity');
app.use(cookieParser());
const PORT = parseInt(process.env.PORT || '4001', 10);

const addressSchema = z.object({
  name: z.string().min(2).max(80),
  phone: z.string().regex(/^[0-9]{10}$/, 'Phone must be 10 digits'),
  line1: z.string().min(3).max(120),
  line2: z.string().max(120).optional().default(''),
  city: z.string().min(2).max(60),
  state: z.string().min(2).max(60),
  pincode: z.string().regex(/^[0-9]{6}$/, 'Pincode must be 6 digits'),
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'customer',
  addresses       JSONB NOT NULL DEFAULT '[]',
  totp_secret     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));
`;

let pool = null;

function signToken(user) {
  const jti = uuid();
  const csrf = uuid();
  const token = jwt.sign({ sub: user.id, role: user.role, csrf, jti }, config.jwtSecret, { expiresIn: '1h' });
  return { token, csrf, jti };
}

function setAuthCookie(res, token) {
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 3600 * 1000, path: '/' });
}

const publicAddress = (a) => ({ _id: a._id, name: a.name, phone: a.phone, line1: a.line1, line2: a.line2, city: a.city, state: a.state, pincode: a.pincode });

function publicUser(u) {
  const addresses = (Array.isArray(u.addresses) ? u.addresses : []).map(publicAddress);
  return { id: u.id, email: u.email, name: u.name, role: u.role, addresses };
}

const registerSchema = z.object({ name: z.string().min(2).max(80), email: z.string().email(), password: z.string().min(8).max(128) });
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1), otp: z.string().max(10).optional() });

async function findByEmail(email) {
  const r = await pool.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  return r.rows[0] || null;
}

async function findById(id) {
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return r.rows[0] || null;
}

function rowAddresses(row) {
  const a = row?.addresses;
  return Array.isArray(a) ? a : [];
}

function rowToUser(row) {
  return { id: row.id, email: row.email, name: row.name, role: row.role, addresses: rowAddresses(row), totpSecret: row.totp_secret };
}

function jsonAddressesOf(user) {
  return (user.addresses || []).map(publicAddress);
}

app.post('/v1/auth/register', asyncH(async (req, res) => {
  const { name, email, password } = validate(registerSchema, req.body);
  const exists = await findByEmail(email);
  if (exists) throw new HttpError(409, 'EMAIL_TAKEN', 'Email already registered');
  const id = uuid();
  const hash = await bcrypt.hash(password, 10);
  await pool.query('INSERT INTO users (id, email, name, password_hash, role, addresses) VALUES ($1,$2,$3,$4,$5,$6)', [id, email.toLowerCase(), name, hash, 'customer', JSON.stringify([])]);
  const { token, csrf } = signToken({ id, role: 'customer' });
  setAuthCookie(res, token);
  const user = { id, email: email.toLowerCase(), name, role: 'customer', addresses: [] };
  res.status(201).json({ user: publicUser(user), csrfToken: csrf });
}));

app.post('/v1/auth/login', asyncH(async (req, res) => {
  const { email, password, otp } = validate(loginSchema, req.body);
  const row = await findByEmail(email);
  if (!row || !(await bcrypt.compare(password, row.password_hash || ''))) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }
  if (row.role === 'admin' && config.adminMfaEnforce) {
    const secret = row.totp_secret || config.adminTotpSecret;
    if (!otp || !authenticator.verify({ token: String(otp), secret })) {
      throw new HttpError(401, 'MFA_REQUIRED', 'Valid admin OTP required');
    }
  }
  const { token, csrf } = signToken(row);
  setAuthCookie(res, token);
  const user = { ...rowToUser(row) };
  res.json({ user: publicUser(user), csrfToken: csrf });
}));

app.get('/v1/auth/session', asyncH(async (req, res) => {
  let userId = req.header('x-user-id');
  let role = req.header('x-user-role');
  let csrf = req.header('x-user-csrf');
  if (!userId && req.cookies?.token) {
    try { const p = jwt.verify(req.cookies.token, config.jwtSecret); userId = p.sub; role = p.role; csrf = p.csrf; } catch { /* fall through */ }
  }
  if (!userId) return res.json({ authenticated: false });
  const row = await findById(userId);
  if (!row) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: publicUser(rowToUser(row)), csrfToken: csrf });
}));

app.post('/v1/auth/refresh', asyncH(async (req, res) => {
  let userId = req.header('x-user-id');
  if (!userId && req.cookies?.token) {
    try { userId = jwt.verify(req.cookies.token, config.jwtSecret).sub; } catch { throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid token'); }
  }
  if (!userId) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
  const row = await findById(userId);
  if (!row) throw new HttpError(401, 'UNAUTHENTICATED', 'User no longer exists');
  const { token, csrf } = signToken(row);
  setAuthCookie(res, token);
  res.json({ user: publicUser(rowToUser(row)), csrfToken: csrf });
}));

// Addresses
app.get('/v1/addresses', requireUser, asyncH(async (req, res) => {
  const row = await findById(req.user.id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'User not found');
  res.json({ addresses: jsonAddressesOf(rowToUser(row)) });
}));

app.post('/v1/addresses', requireUser, asyncH(async (req, res) => {
  const data = validate(addressSchema, req.body);
  const row = await findById(req.user.id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'User not found');
  const addresses = rowAddresses(row);
  addresses.push({ ...data, _id: uuid() });
  await pool.query('UPDATE users SET addresses = $1 WHERE id = $2', [JSON.stringify(addresses), row.id]);
  res.status(201).json({ addresses: jsonAddressesOf({ addresses }) });
}));

app.put('/v1/addresses/:aid', requireUser, asyncH(async (req, res) => {
  const data = validate(addressSchema, req.body);
  const row = await findById(req.user.id);
  const addresses = rowAddresses(row || {});
  const addr = addresses.find((a) => a._id === req.params.aid);
  if (!addr) throw new HttpError(404, 'NOT_FOUND', 'Address not found');
  Object.assign(addr, data);
  await pool.query('UPDATE users SET addresses = $1 WHERE id = $2', [JSON.stringify(addresses), row.id]);
  res.json({ addresses: jsonAddressesOf({ addresses }) });
}));

app.delete('/v1/addresses/:aid', requireUser, asyncH(async (req, res) => {
  const row = await findById(req.user.id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'User not found');
  const addresses = rowAddresses(row).filter((a) => a._id !== req.params.aid);
  await pool.query('UPDATE users SET addresses = $1 WHERE id = $2', [JSON.stringify(addresses), row.id]);
  res.json({ addresses: jsonAddressesOf({ addresses }) });
}));

// Internal endpoints (service-to-service; internal-key guard applies)
app.get('/internal/users/:id', asyncH(async (req, res) => {
  const row = await findById(req.params.id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'User not found');
  res.json({ user: publicUser(rowToUser(row)) });
}));
app.get('/internal/users/:id/addresses/:aid', asyncH(async (req, res) => {
  const row = await findById(req.params.id);
  const addr = rowAddresses(row || {}).find((a) => a._id === req.params.aid);
  if (!addr) throw new HttpError(404, 'NOT_FOUND', 'Address not found');
  res.json({ address: publicAddress(addr) });
}));

async function seed() {
  if (!await findByEmail(config.adminEmail)) {
    const id = uuid();
    await pool.query('INSERT INTO users (id, email, name, password_hash, role, totp_secret) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, config.adminEmail.toLowerCase(), 'Bazaarly Admin', await bcrypt.hash(config.adminPassword, 10), 'admin', config.adminTotpSecret]);
    logger.info('seeded admin user', { email: config.adminEmail });
  }
  if (!await findByEmail(config.demoEmail)) {
    const id = uuid();
    const addr = [{ _id: uuid(), name: 'Demo Customer', phone: '9876543210', line1: '12, MG Road', line2: 'Near Metro Station', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' }];
    await pool.query('INSERT INTO users (id, email, name, password_hash, role, addresses) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, config.demoEmail.toLowerCase(), 'Demo Customer', await bcrypt.hash(config.demoPassword, 10), 'customer', JSON.stringify(addr)]);
    logger.info('seeded demo user', { email: config.demoEmail });
  }
}

(async () => {
  pool = await connectDb('bazaarly_identity');
  await pool.query(SCHEMA);
  await seed();
  finish(app);
  listen(app, PORT, 'identity');
})().catch((err) => { logger.error('identity failed to start', { err: err.message }); process.exit(1); });
