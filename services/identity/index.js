'use strict';
// Identity service: users, auth (JWT in HttpOnly cookie), addresses, admin MFA.
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const { z } = require('zod');
const config = require('../../shared/config');
const logger = require('../../shared/logger');
const cookieParser = require('cookie-parser');
const { createApp, finish, listen, asyncH, validate, requireUser, HttpError } = require('../../shared/http');
const { connectMongo, mongoose } = require('../../shared/db');

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

const addressMongooseSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  name: String,
  phone: String,
  line1: String,
  line2: { type: String, default: '' },
  city: String,
  state: String,
  pincode: String,
}, { _id: false, versionKey: false });

const userSchema = new mongoose.Schema({
  _id: String,
  email: { type: String, unique: true, index: true, lowercase: true },
  name: String,
  passwordHash: String,
  role: { type: String, enum: ['customer', 'admin'], default: 'customer' },
  addresses: [addressMongooseSchema],
  totpSecret: String,
  createdAt: { type: Date, default: Date.now },
}, { collection: 'users', versionKey: false, _id: false });
const User = mongoose.model('IdentityUser', userSchema);

function signToken(user) {
  const jti = uuid();
  const csrf = uuid();
  const token = jwt.sign({ sub: user._id, role: user.role, csrf, jti }, config.jwtSecret, { expiresIn: '1h' });
  return { token, csrf, jti };
}

function setAuthCookie(res, token) {
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 3600 * 1000, path: '/' });
}

function publicUser(u) {
  return { id: u._id, email: u.email, name: u.name, role: u.role, addresses: (u.addresses || []).map((a) => ({ ...a, _id: a._id })) };
}

const registerSchema = z.object({ name: z.string().min(2).max(80), email: z.string().email(), password: z.string().min(8).max(128) });
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1), otp: z.string().max(10).optional() });

app.post('/v1/auth/register', asyncH(async (req, res) => {
  const { name, email, password } = validate(registerSchema, req.body);
  const exists = await User.findOne({ email: email.toLowerCase() });
  if (exists) throw new HttpError(409, 'EMAIL_TAKEN', 'Email already registered');
  const user = await User.create({ _id: uuid(), email: email.toLowerCase(), name, passwordHash: await bcrypt.hash(password, 10), role: 'customer', addresses: [] });
  const { token, csrf } = signToken(user);
  setAuthCookie(res, token);
  res.status(201).json({ user: publicUser(user), csrfToken: csrf });
}));

app.post('/v1/auth/login', asyncH(async (req, res) => {
  const { email, password, otp } = validate(loginSchema, req.body);
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user || !(await bcrypt.compare(password, user.passwordHash || ''))) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }
  if (user.role === 'admin' && config.adminMfaEnforce) {
    const secret = user.totpSecret || config.adminTotpSecret;
    if (!otp || !authenticator.verify({ token: String(otp), secret })) {
      throw new HttpError(401, 'MFA_REQUIRED', 'Valid admin OTP required');
    }
  }
  const { token, csrf } = signToken(user);
  setAuthCookie(res, token);
  res.json({ user: publicUser(user), csrfToken: csrf });
}));

app.get('/v1/auth/session', asyncH(async (req, res) => {
  // Gateway injects x-user-* after verifying the cookie; if absent, parse cookie directly as fallback.
  let userId = req.header('x-user-id');
  let role = req.header('x-user-role');
  let csrf = req.header('x-user-csrf');
  if (!userId && req.cookies?.token) {
    try { const p = jwt.verify(req.cookies.token, config.jwtSecret); userId = p.sub; role = p.role; csrf = p.csrf; } catch { /* fall through */ }
  }
  if (!userId) return res.json({ authenticated: false });
  const user = await User.findById(userId);
  if (!user) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: publicUser(user), csrfToken: csrf });
}));

app.post('/v1/auth/refresh', asyncH(async (req, res) => {
  let userId = req.header('x-user-id');
  if (!userId && req.cookies?.token) {
    try { userId = jwt.verify(req.cookies.token, config.jwtSecret).sub; } catch { throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid token'); }
  }
  if (!userId) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
  const user = await User.findById(userId);
  if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'User no longer exists');
  const { token, csrf } = signToken(user);
  setAuthCookie(res, token);
  res.json({ user: publicUser(user), csrfToken: csrf });
}));

// Addresses CRUD
app.get('/v1/addresses', requireUser, asyncH(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) throw new HttpError(404, 'NOT_FOUND', 'User not found');
  res.json({ addresses: (user.addresses || []).map((a) => ({ ...a, _id: a._id })) });
}));

app.post('/v1/addresses', requireUser, asyncH(async (req, res) => {
  const data = validate(addressSchema, req.body);
  const user = await User.findById(req.user.id);
  if (!user) throw new HttpError(404, 'NOT_FOUND', 'User not found');
  user.addresses = user.addresses || [];
  user.addresses.push({ ...data, _id: uuid() });
  await user.save();
  res.status(201).json({ addresses: user.addresses });
}));

app.put('/v1/addresses/:aid', requireUser, asyncH(async (req, res) => {
  const data = validate(addressSchema, req.body);
  const user = await User.findById(req.user.id);
  const addr = user && (user.addresses || []).find((a) => a._id === req.params.aid);
  if (!addr) throw new HttpError(404, 'NOT_FOUND', 'Address not found');
  Object.assign(addr, data);
  user.markModified('addresses');
  await user.save();
  res.json({ addresses: user.addresses });
}));

app.delete('/v1/addresses/:aid', requireUser, asyncH(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) throw new HttpError(404, 'NOT_FOUND', 'User not found');
  user.addresses = (user.addresses || []).filter((a) => a._id !== req.params.aid);
  user.markModified('addresses');
  await user.save();
  res.json({ addresses: user.addresses });
}));

// Internal endpoints (service-to-service only, missing internal key is rejected by createApp)
app.get('/internal/users/:id', asyncH(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new HttpError(404, 'NOT_FOUND', 'User not found');
  res.json({ user: publicUser(user) });
}));
app.get('/internal/users/:id/addresses/:aid', asyncH(async (req, res) => {
  const user = await User.findById(req.params.id);
  const addr = user && (user.addresses || []).find((a) => a._id === req.params.aid);
  if (!addr) throw new HttpError(404, 'NOT_FOUND', 'Address not found');
  res.json({ address: addr });
}));

async function seed() {
  const admin = await User.findOne({ email: config.adminEmail });
  if (!admin) {
    await User.create({ _id: uuid(), email: config.adminEmail, name: 'Bazaarly Admin', passwordHash: await bcrypt.hash(config.adminPassword, 10), role: 'admin', totpSecret: config.adminTotpSecret, addresses: [] });
    logger.info('seeded admin user', { email: config.adminEmail });
  }
  const demo = await User.findOne({ email: config.demoEmail });
  if (!demo) {
    await User.create({
      _id: uuid(), email: config.demoEmail, name: 'Demo Customer', passwordHash: await bcrypt.hash(config.demoPassword, 10), role: 'customer',
      addresses: [{ _id: uuid(), name: 'Demo Customer', phone: '9876543210', line1: '12, MG Road', line2: 'Near Metro Station', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' }],
    });
    logger.info('seeded demo user', { email: config.demoEmail });
  }
}

(async () => {
  await connectMongo('identity');
  await seed();
  finish(app);
  listen(app, PORT, 'identity');
})().catch((err) => { logger.error('identity failed to start', { err: err.message }); process.exit(1); });
