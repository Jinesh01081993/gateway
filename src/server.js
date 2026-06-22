import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import axios from 'axios';
import pg from 'pg';

const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 8080;

const services = {
  frontend: process.env.FRONTEND_URL || 'http://localhost:5173',
  gateway: process.env.GATEWAY_URL || `http://localhost:${PORT}`,
  auth: process.env.AUTH_SERVICE_URL || 'http://localhost:4001',
  profile: process.env.PROFILE_SERVICE_URL || 'http://localhost:4002'
};

const dbPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'microservice_auth',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 2000
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(morgan('combined'));

const checkHttpService = async (name, baseUrl, path = '/health') => {
  if (name === 'gateway') {
    return {
      name,
      type: 'node-service',
      status: 'UP',
      url: baseUrl,
      checkedAt: new Date().toISOString()
    };
  }

  try {
    const started = Date.now();
    const response = await axios.get(`${baseUrl}${path}`, { timeout: 2500 });

    return {
      name,
      type: name === 'frontend' ? 'react-frontend' : 'node-service',
      status: response.status >= 200 && response.status < 400 ? 'UP' : 'DOWN',
      url: baseUrl,
      latencyMs: Date.now() - started,
      details: name === 'frontend' ? { pageLoaded: true } : response.data,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      name,
      type: name === 'frontend' ? 'react-frontend' : 'node-service',
      status: 'DOWN',
      url: baseUrl,
      error: error.code || error.message,
      checkedAt: new Date().toISOString()
    };
  }
};

const checkDatabase = async () => {
  const started = Date.now();

  try {
    const result = await dbPool.query('SELECT NOW() as server_time');

    return {
      name: 'postgres',
      type: 'database',
      status: 'UP',
      url: `${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}`,
      latencyMs: Date.now() - started,
      details: {
        database: process.env.DB_NAME || 'microservice_auth',
        serverTime: result.rows[0].server_time
      },
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      name: 'postgres',
      type: 'database',
      status: 'DOWN',
      url: `${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}`,
      error: error.code || error.message,
      checkedAt: new Date().toISOString()
    };
  }
};

function requireAuth(req, res, next) {
  try {
    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({ message: 'Authorization token is required' });
    }

    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

const proxyError = (res, error, fallbackMessage) => {
  if (error.response) {
    return res.status(error.response.status).json(error.response.data);
  }

  return res.status(503).json({
    message: fallbackMessage,
    details: error.code || error.message
  });
};

app.get('/', (_req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Gateway — Health</title>
      <style>
        body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
        .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 2rem 3rem; text-align: center; }
        .badge { display: inline-block; background: #22c55e22; color: #4ade80; border: 1px solid #4ade8044; border-radius: 20px; padding: 4px 16px; font-size: 0.85rem; margin: 0.5rem 0 1.5rem; }
        a { color: #818cf8; }
        ul { text-align: left; margin-top: 1rem; }
        li { margin: 0.4rem 0; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>🛡️ API Gateway</h1>
        <div class="badge">● UP</div>
        <p>Running on port <strong>${PORT}</strong></p>
        <ul>
          <li><a href="/health">/health</a> — Gateway health (JSON)</li>
          <li><a href="/api/health/all">/api/health/all</a> — All services health (JSON)</li>
        </ul>
        <p style="margin-top:1.5rem; font-size:0.8rem; color:#64748b;">Timestamp: ${new Date().toISOString()}</p>
      </div>
    </body>
    </html>
  `);
});

app.get('/health', (_req, res) => {
  res.json({ service: 'gateway', status: 'UP', timestamp: new Date().toISOString() });
});

app.get('/api/health/all', async (_req, res) => {
  const results = await Promise.all([
    checkHttpService('frontend', services.frontend, '/'),
    checkHttpService('gateway', services.gateway),
    checkHttpService('auth', services.auth),
    checkHttpService('profile', services.profile),
    checkDatabase()
  ]);

  const overallStatus = results.every(service => service.status === 'UP') ? 'UP' : 'DEGRADED';

  res.json({
    overallStatus,
    services: results,
    checkedAt: new Date().toISOString()
  });
});

app.post('/api/auth/signup', async (req, res) => {
  try {
    const response = await axios.post(`${services.auth}/auth/signup`, req.body, { timeout: 3000 });
    res.status(response.status).json(response.data);
  } catch (error) {
    return proxyError(res, error, 'Auth service is unavailable');
  }
});

app.post('/api/auth/signin', async (req, res) => {
  try {
    const response = await axios.post(`${services.auth}/auth/signin`, req.body, { timeout: 3000 });
    res.status(response.status).json(response.data);
  } catch (error) {
    return proxyError(res, error, 'Auth service is unavailable');
  }
});

app.get('/api/profile/me', async (req, res) => {
  try {
    const response = await axios.get(`${services.profile}/profile/me`, {
      timeout: 3000,
      headers: { authorization: req.headers.authorization || '' }
    });
    res.status(response.status).json(response.data);
  } catch (error) {
    return proxyError(res, error, 'Profile service is unavailable');
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const response = await axios.get(`${services.auth}/users`, {
      headers: { authorization: req.headers.authorization || '' }
    });

    res.status(response.status).json(response.data);
  } catch (error) {
    return proxyError(res, error, 'Auth service is unavailable');
  }
});

app.put('/api/users/:id', async (req, res) => {
  try {
    const response = await axios.put(
      `${services.auth}/users/${req.params.id}`,
      req.body,
      {
        headers: { authorization: req.headers.authorization || '' }
      }
    );

    res.status(response.status).json(response.data);
  } catch (error) {
    return proxyError(res, error, 'Auth service is unavailable');
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const response = await axios.delete(
      `${services.auth}/users/${req.params.id}`,
      {
        headers: { authorization: req.headers.authorization || '' }
      }
    );

    res.status(response.status).json(response.data);
  } catch (error) {
    return proxyError(res, error, 'Auth service is unavailable');
  }
});

app.put('/users/:id', requireAuth, async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email) {
    return res.status(400).json({ message: 'name and email are required' });
  }

  let query, params;

  if (password) {
    if (password.length < 6) {
      return res.status(400).json({ message: 'password must be at least 6 characters' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    query = `
      UPDATE users
      SET name = $1, email = $2, password_hash = $3
      WHERE id = $4
      RETURNING id, name, email, created_at, updated_at
    `;
    params = [name.trim(), email.toLowerCase().trim(), passwordHash, req.params.id];
  } else {
    query = `
      UPDATE users
      SET name = $1, email = $2
      WHERE id = $3
      RETURNING id, name, email, created_at, updated_at
    `;
    params = [name.trim(), email.toLowerCase().trim(), req.params.id];
  }

  const result = await pool.query(query, params);

  if (result.rowCount === 0) {
    return res.status(404).json({ message: 'User not found' });
  }

  res.json({
    message: 'User updated successfully',
    user: publicUser(result.rows[0])
  });
});

app.listen(PORT, () => {
  console.log(`Gateway running on port ${PORT}`);
});
