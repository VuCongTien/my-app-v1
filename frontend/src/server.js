const express = require('express');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Health Check Endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP', service: 'frontend', timestamp: new Date().toISOString() });
});

// Endpoint to provide runtime configuration to the browser client
app.get('/api/config', (req, res) => {
  res.json({
    backendUrl: BACKEND_URL,
    frontendPod: process.env.POD_NAME || process.env.HOSTNAME || 'frontend-local-pod',
    frontendAZ: process.env.NODE_AZ || process.env.AWS_AVAILABILITY_ZONE || 'ap-southeast-1a'
  });
});

// Proxy route to forward requests to the Backend Service inside private network
app.all('/api/proxy/*', async (req, res) => {
  const targetPath = req.params[0];
  const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const url = `${BACKEND_URL}/api/${targetPath}${query}`;

  try {
    const fetchOptions = {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {})
      }
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(url, fetchOptions);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error(`[Proxy Error] Failed to reach backend at ${url}:`, error.message);
    res.status(502).json({
      error: 'Backend Service Unreachable',
      targetUrl: url,
      message: error.message,
      hint: 'Ensure Backend pod is running in private subnet and accessible via Kubernetes Service DNS.'
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🌐 EKS Production Lab Frontend Web Server running on port ${PORT}`);
  console.log(`🔗 Target Backend Service URL: ${BACKEND_URL}`);
  console.log(`=======================================================`);
});
