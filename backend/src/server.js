const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { AppConfigDataClient, StartConfigurationSessionCommand, GetLatestConfigurationCommand } = require('@aws-sdk/client-appconfigdata');
const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Environment variables provided by Kubernetes Downward API & ConfigMaps
const podName = process.env.POD_NAME || process.env.HOSTNAME || 'local-pod-' + Math.random().toString(36).substring(7);
const nodeName = process.env.NODE_NAME || 'local-node-1';
const podNamespace = process.env.POD_NAMESPACE || 'production';
const nodeAZ = process.env.NODE_AZ || process.env.AWS_AVAILABILITY_ZONE || 'ap-southeast-1a';
const awsRegion = process.env.AWS_REGION || 'ap-southeast-1';

// Cache for database secrets & AppConfig
let dbSecretsCache = null;
let appConfigCache = { message: 'Default internal app config', version: '1.0.0' };
let dbPool = null;

// Initialize AWS AppConfig client (Uses IRSA - IAM Roles for Service Accounts)
const appConfigClient = new AppConfigDataClient({ region: awsRegion });

/**
 * Read database credentials from the Secrets Store CSI mounted JSON file.
 * Environment variables remain available for local development and provide
 * non-secret connection settings such as the RDS hostname and database name.
 */
async function getDatabaseSecrets() {
  if (dbSecretsCache) {
    return dbSecretsCache;
  }

  const secretName = process.env.SECRET_NAME;
  let secret = {};
  let source = 'Environment Variables';

  try {
    if (secretName) {
      const secretPath = path.join('/mnt/secrets-store', secretName);
      const secretJson = await fs.readFile(secretPath, 'utf8');
      const parsedSecret = JSON.parse(secretJson);
      if (!parsedSecret || typeof parsedSecret !== 'object' || Array.isArray(parsedSecret)) {
        throw new Error('Mounted database secret must contain a JSON object.');
      }
      secret = parsedSecret;
      source = 'Secrets Store CSI Driver';
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[Database] Could not read or parse the mounted database secret.');
    }
  }

  const secrets = {
    host: secret.host || secret.hostname || process.env.DB_HOST,
    port: parseInt(secret.port || process.env.DB_PORT || '5432', 10),
    username: secret.username || secret.user || process.env.DB_USER,
    password: secret.password || process.env.DB_PASSWORD,
    dbname: secret.dbname || secret.database || process.env.DB_NAME,
    source
  };

  const missing = ['host', 'username', 'password', 'dbname'].filter((key) => !secrets[key]);
  if (missing.length) {
    console.warn(`[Database] Database configuration is incomplete (missing: ${missing.join(', ')}).`);
    return null;
  }

  dbSecretsCache = secrets;
  return dbSecretsCache;
}

/**
 * Initialize PostgreSQL Database Connection Pool
 */
async function initDbPool() {
  if (dbPool) return dbPool;

  const secrets = await getDatabaseSecrets();
  if (!secrets) {
    console.log('[Database] Credentials or connection settings are unavailable. Database features will run in mock mode.');
    return null;
  }

  let pool;
  let client;
  try {
    pool = new Pool({
      host: secrets.host,
      port: secrets.port,
      user: secrets.username,
      password: secrets.password,
      database: secrets.dbname,
      connectionTimeoutMillis: 3000,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });

    // Auto-create visits table if connected
    client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS page_visits (
        id SERIAL PRIMARY KEY,
        pod_name VARCHAR(100) NOT NULL,
        node_az VARCHAR(50) NOT NULL,
        visited_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    client.release();
    client = null;
    dbPool = pool;
    console.log('[Database] Successfully connected to PostgreSQL and ensured schema!');
    return dbPool;
  } catch (error) {
    console.error(`[Database] PostgreSQL connection or schema initialization failed (code: ${error.code || 'unknown'}).`);
    if (client) client.release();
    if (pool) await pool.end().catch(() => {});
    dbPool = null;
    throw error;
  }
}

/**
 * Read this deployment's replica status through the in-cluster Kubernetes API.
 */
async function getDeploymentStatus(namespace, deploymentName) {
  if (!deploymentName || !namespace) {
    throw new Error('Deployment identity is not configured.');
  }

  const serviceAccountPath = '/var/run/secrets/kubernetes.io/serviceaccount';
  const [token, ca] = await Promise.all([
    fs.readFile(path.join(serviceAccountPath, 'token'), 'utf8'),
    fs.readFile(path.join(serviceAccountPath, 'ca.crt'))
  ]);
  const apiPath = `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(deploymentName)}`;

  return new Promise((resolve, reject) => {
    const request = https.get({
      hostname: 'kubernetes.default.svc',
      path: apiPath,
      ca,
      headers: { Authorization: `Bearer ${token.trim()}` },
      timeout: 3000
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Kubernetes API returned status ${response.statusCode}.`));
          return;
        }
        try {
          const deployment = JSON.parse(body);
          resolve({
            deployment: deployment.metadata.name,
            namespace,
            desiredReplicas: deployment.spec.replicas || 0,
            currentReplicas: deployment.status?.replicas || 0,
            readyReplicas: deployment.status?.readyReplicas || 0,
            updatedAt: new Date().toISOString()
          });
        } catch {
          reject(new Error('Kubernetes API returned invalid deployment data.'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Kubernetes API request timed out.')));
    request.on('error', reject);
  });
}

/**
 * Fetch configuration from AWS AppConfig
 */
async function fetchAppConfig() {
  const appId = process.env.APPCONFIG_APPLICATION;
  const envId = process.env.APPCONFIG_ENVIRONMENT;
  const profileId = process.env.APPCONFIG_PROFILE;

  if (!appId || !envId || !profileId) {
    return { status: 'Not Configured', data: appConfigCache };
  }

  try {
    const sessionCmd = new StartConfigurationSessionCommand({
      ApplicationIdentifier: appId,
      EnvironmentIdentifier: envId,
      ConfigurationProfileIdentifier: profileId,
    });
    const session = await appConfigClient.send(sessionCmd);

    const configCmd = new GetLatestConfigurationCommand({
      ConfigurationToken: session.InitialConfigurationToken,
    });
    const configResp = await appConfigClient.send(configCmd);
    if (configResp.Configuration) {
      const str = Buffer.from(configResp.Configuration).toString('utf-8');
      appConfigCache = JSON.parse(str);
      return { status: 'Connected (AWS AppConfig)', data: appConfigCache };
    }
  } catch (error) {
    console.warn('[AppConfig] Error fetching config:', error.message);
    return { status: 'Error: ' + error.message, data: appConfigCache };
  }

  return { status: 'Active (Cached)', data: appConfigCache };
}

// ----------------------------------------------------
// ROUTES
// ----------------------------------------------------

// Health Check Endpoint (K8s Liveness & Readiness Probe)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
});

// Pod & System Topology Info Endpoint
app.get('/api/info', async (req, res) => {
  const secrets = await getDatabaseSecrets();
  const appConfigResult = await fetchAppConfig();

  res.json({
    podName,
    nodeName,
    namespace: podNamespace,
    az: nodeAZ,
    region: awsRegion,
    timestamp: new Date().toISOString(),
    security: {
      authMode: 'IAM Role for Service Accounts (IRSA)',
      secretsManager: secrets ? {
        status: 'Connected',
        source: secrets.source,
        dbHost: secrets.host,
        dbUser: secrets.username,
        dbName: secrets.dbname
      } : {
        status: 'Not Connected / Using Environment Vars',
        source: 'None'
      },
      appConfig: appConfigResult
    }
  });
});

// Current and desired backend replica counts for the HPA dashboard.
app.get('/api/hpa/status', async (req, res) => {
  try {
    const [backend, frontend] = await Promise.all([
      getDeploymentStatus('backend-ns', 'backend-app-backend'),
      getDeploymentStatus('frontend-ns', 'frontend-app-frontend')
    ]);
    res.json({ backend, frontend });
  } catch (error) {
    console.warn(`[HPA] Could not read backend replica status (code: ${error.code || 'unavailable'}).`);
    res.status(503).json({ error: 'Backend replica status is unavailable.' });
  }
});

// Database Visits Endpoint - Read History
app.get('/api/db/visits', async (req, res) => {
  try {
    const pool = await initDbPool();
    if (!pool) {
      return res.json({
        dbStatus: 'Disconnected / Mock Mode',
        totalVisits: 0,
        recentVisits: [
          { id: 1, pod_name: podName, node_az: nodeAZ, visited_at: new Date().toISOString() }
        ],
        message: 'PostgreSQL connection settings or credentials are unavailable.'
      });
    }

    const countRes = await pool.query('SELECT COUNT(*) FROM page_visits');
    const recentRes = await pool.query('SELECT * FROM page_visits ORDER BY id DESC LIMIT 10');

    res.json({
      dbStatus: 'Connected (RDS PostgreSQL)',
      totalVisits: parseInt(countRes.rows[0].count, 10),
      recentVisits: recentRes.rows
    });
  } catch (error) {
    console.error('[Database] Failed to read page visits.');
    res.status(500).json({
      dbStatus: 'Error',
      error: 'PostgreSQL connection or query failed.'
    });
  }
});

// Database Visits Endpoint - Read one visit
app.get('/api/db/visits/:id', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Visit id must be a positive integer.' });
  }

  try {
    const pool = await initDbPool();
    if (!pool) {
      return res.status(503).json({ error: 'Database is not connected.' });
    }

    const result = await pool.query('SELECT * FROM page_visits WHERE id = $1', [id]);
    if (!result.rowCount) {
      return res.status(404).json({ error: 'Visit not found.' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('[Database] Failed to read page visit.');
    res.status(500).json({ error: 'PostgreSQL query failed.' });
  }
});

// Database Visits Endpoint - Create a new visit
app.post('/api/db/visit', async (req, res) => {
  try {
    const pool = await initDbPool();
    if (!pool) {
      return res.json({
        success: false,
        message: 'Database not connected. Visit recorded in mock mode only.',
        recorded: { pod_name: podName, node_az: nodeAZ, visited_at: new Date().toISOString() }
      });
    }

    const insertRes = await pool.query(
      'INSERT INTO page_visits (pod_name, node_az) VALUES ($1, $2) RETURNING *',
      [podName, nodeAZ]
    );

    res.json({
      success: true,
      message: 'Recorded visit to RDS PostgreSQL!',
      recorded: insertRes.rows[0]
    });
  } catch (error) {
    console.error('[Database] Failed to record page visit.');
    res.status(500).json({ success: false, error: 'PostgreSQL connection or query failed.' });
  }
});

// Database Visits Endpoint - Update a visit
app.put('/api/db/visits/:id', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const { pod_name: podNameValue, node_az: nodeAzValue } = req.body || {};

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Visit id must be a positive integer.' });
  }
  if (typeof podNameValue !== 'string' || !podNameValue.trim() ||
      typeof nodeAzValue !== 'string' || !nodeAzValue.trim()) {
    return res.status(400).json({ error: 'pod_name and node_az are required.' });
  }

  try {
    const pool = await initDbPool();
    if (!pool) {
      return res.status(503).json({ error: 'Database is not connected.' });
    }

    const result = await pool.query(
      'UPDATE page_visits SET pod_name = $1, node_az = $2 WHERE id = $3 RETURNING *',
      [podNameValue.trim(), nodeAzValue.trim(), id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: 'Visit not found.' });
    }

    res.json({ success: true, visit: result.rows[0] });
  } catch (error) {
    console.error('[Database] Failed to update page visit.');
    res.status(500).json({ error: 'PostgreSQL query failed.' });
  }
});

// Database Visits Endpoint - Delete a visit
app.delete('/api/db/visits/:id', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Visit id must be a positive integer.' });
  }

  try {
    const pool = await initDbPool();
    if (!pool) {
      return res.status(503).json({ error: 'Database is not connected.' });
    }

    const result = await pool.query(
      'DELETE FROM page_visits WHERE id = $1 RETURNING *',
      [id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: 'Visit not found.' });
    }

    res.json({ success: true, deleted: result.rows[0] });
  } catch (error) {
    console.error('[Database] Failed to delete page visit.');
    res.status(500).json({ error: 'PostgreSQL query failed.' });
  }
});

// CPU Stress Endpoint to test Autoscaling (HPA)
app.all('/api/stress', (req, res) => {
  const durationSeconds = parseInt(req.query.seconds || req.body?.seconds || '10', 10);
  const cappedDuration = Math.min(Math.max(durationSeconds, 1), 60); // Cap between 1s and 60s

  console.log(`[Stress Test] Starting CPU stress on Pod ${podName} for ${cappedDuration} seconds...`);
  
  const startTime = Date.now();
  let iterations = 0;

  // Intensive CPU calculation loop (calculating primes / math operations)
  while ((Date.now() - startTime) < cappedDuration * 1000) {
    for (let i = 0; i < 100000; i++) {
      Math.sqrt(Math.random() * Math.random() * 99999);
    }
    iterations++;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`[Stress Test] Completed CPU stress on Pod ${podName}. Duration: ${elapsed}s, Iterations: ${iterations}`);

  res.json({
    message: `CPU load generated successfully on Pod ${podName}`,
    podName,
    nodeAZ,
    durationRequestedSeconds: cappedDuration,
    actualDurationSeconds: parseFloat(elapsed),
    iterationsCompleted: iterations,
    hpaNotice: 'If HPA threshold (e.g., CPU > 50%) is met, Kubernetes will scale out new pods.'
  });
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🚀 EKS Production Lab Backend Service running on port ${PORT}`);
  console.log(`📌 Pod Name: ${podName}`);
  console.log(`📌 Node Name: ${nodeName}`);
  console.log(`📌 Node AZ: ${nodeAZ}`);
  console.log(`📌 Namespace: ${podNamespace}`);
  console.log(`=======================================================`);
});
