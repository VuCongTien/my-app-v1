// Global State
let config = { backendUrl: '', frontendPod: '', frontendAZ: '' };
let isPolling = true;
let pollTimer = null;
let totalRequests = 0;
let podHitMap = {};
let azHitMap = {};
let hpaMonitorRunId = 0;

// DOM Elements
const pollingBadge = document.getElementById('pollingBadge');
const pollingStatusText = document.getElementById('pollingStatusText');
const togglePollingBtn = document.getElementById('togglePollingBtn');
const manualRefreshBtn = document.getElementById('manualRefreshBtn');
const resetStatsBtn = document.getElementById('resetStatsBtn');

const activeAzBadge = document.getElementById('activeAzBadge');
const activePodName = document.getElementById('activePodName');
const activeNodeName = document.getElementById('activeNodeName');
const activeNamespace = document.getElementById('activeNamespace');
const activeLatency = document.getElementById('activeLatency');

const totalRequestsCount = document.getElementById('totalRequestsCount');
const uniquePodsCount = document.getElementById('uniquePodsCount');
const podDistributionList = document.getElementById('podDistributionList');
const azDistributionList = document.getElementById('azDistributionList');

const stressDuration = document.getElementById('stressDuration');
const startStressBtn = document.getElementById('startStressBtn');
const stressStatusContainer = document.getElementById('stressStatusContainer');
const stressProgressBar = document.getElementById('stressProgressBar');
const stressStatusText = document.getElementById('stressStatusText');
const hpaCurrentReplicas = document.getElementById('hpaCurrentReplicas');
const hpaReadyReplicas = document.getElementById('hpaReadyReplicas');
const hpaDesiredReplicas = document.getElementById('hpaDesiredReplicas');
const hpaReplicaMessage = document.getElementById('hpaReplicaMessage');

const dbStatusBadge = document.getElementById('dbStatusBadge');
const dbHostText = document.getElementById('dbHostText');
const dbUserText = document.getElementById('dbUserText');
const dbTotalVisits = document.getElementById('dbTotalVisits');
const logVisitBtn = document.getElementById('logVisitBtn');
const recentVisitsList = document.getElementById('recentVisitsList');
const dbActionStatus = document.getElementById('dbActionStatus');

const secSecretsSource = document.getElementById('secSecretsSource');
const secAppConfigStatus = document.getElementById('secAppConfigStatus');
const secAppConfigData = document.getElementById('secAppConfigData');

// Initialize Application
async function initApp() {
  try {
    const res = await fetch('/api/config');
    config = await res.json();
    console.log('[App] Config loaded:', config);
  } catch (err) {
    console.error('[App] Failed to load config:', err);
  }

  // Setup Event Listeners
  togglePollingBtn.addEventListener('click', togglePolling);
  manualRefreshBtn.addEventListener('click', () => fetchInfoData(true));
  resetStatsBtn.addEventListener('click', resetDistributionStats);
  startStressBtn.addEventListener('click', triggerCpuStress);
  logVisitBtn.addEventListener('click', logDatabaseVisit);

  // Initial Fetch & Start Polling
  fetchInfoData();
  fetchDbVisitsData();
  refreshHpaStatus();
  setInterval(refreshHpaStatus, 5000);
  startPolling();
}

// Start Auto Polling
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (isPolling) {
      fetchInfoData();
    }
  }, 2000);
}

// Toggle Polling State
function togglePolling() {
  isPolling = !isPolling;
  if (isPolling) {
    pollingStatusText.textContent = 'Auto-Polling (2s)';
    pollingBadge.style.opacity = '1';
    togglePollingBtn.textContent = 'Pause';
    fetchInfoData();
  } else {
    pollingStatusText.textContent = 'Polling Paused';
    pollingBadge.style.opacity = '0.5';
    togglePollingBtn.textContent = 'Resume';
  }
}

// Fetch Backend Topology & Info Data
async function fetchInfoData(isManual = false) {
  const startTime = performance.now();
  try {
    const res = await fetch('/api/proxy/info');
    const latency = Math.round(performance.now() - startTime);
    
    if (!res.ok) {
      const errData = await res.json();
      updateInfoErrorUI(errData, latency);
      return;
    }

    const data = await res.json();
    updateInfoSuccessUI(data, latency);
    trackDistribution(data.podName, data.az);

  } catch (err) {
    const latency = Math.round(performance.now() - startTime);
    updateInfoErrorUI({ message: err.message }, latency);
  }
}

// Update Topology UI on Success
function updateInfoSuccessUI(data, latency) {
  // Update AZ Badge
  activeAzBadge.textContent = data.az || 'Unknown AZ';
  activeAzBadge.className = 'az-badge ' + getAzClass(data.az);

  // Metrics
  activePodName.textContent = data.podName || '--';
  activeNodeName.textContent = data.nodeName || '--';
  activeNamespace.textContent = data.namespace || 'default';
  activeLatency.textContent = `${latency} ms`;

  // Security Cards
  if (data.security) {
    const sec = data.security;
    if (sec.secretsManager) {
      secSecretsSource.textContent = sec.secretsManager.source || sec.secretsManager.status;
      if (sec.secretsManager.dbHost) dbHostText.textContent = sec.secretsManager.dbHost;
      if (sec.secretsManager.dbUser) dbUserText.textContent = sec.secretsManager.dbUser;
    }
    if (sec.appConfig) {
      secAppConfigStatus.textContent = sec.appConfig.status || 'Active';
      secAppConfigData.textContent = JSON.stringify(sec.appConfig.data || {}, null, 2);
    }
  }
}

// Update Topology UI on Error
function updateInfoErrorUI(err, latency) {
  activeAzBadge.textContent = 'UNREACHABLE';
  activeAzBadge.className = 'az-badge az-unknown';
  activePodName.textContent = err.message || 'Error reaching backend';
  activeNodeName.textContent = '--';
  activeLatency.textContent = `${latency} ms`;
}

// Return styling class based on AZ name
function getAzClass(azStr) {
  if (!azStr) return 'az-unknown';
  if (azStr.endsWith('a')) return 'az-a';
  if (azStr.endsWith('b')) return 'az-b';
  if (azStr.endsWith('c')) return 'az-c';
  return 'az-a';
}

// Track Traffic Load Distribution Statistics
function trackDistribution(podName, azName) {
  if (!podName) return;
  totalRequests++;
  
  podHitMap[podName] = (podHitMap[podName] || 0) + 1;
  const azKey = azName || 'Unknown';
  azHitMap[azKey] = (azHitMap[azKey] || 0) + 1;

  renderDistributionUI();
}

function resetDistributionStats() {
  totalRequests = 0;
  podHitMap = {};
  azHitMap = {};
  renderDistributionUI();
}

// Render Pod & AZ Distribution Bars
function renderDistributionUI() {
  totalRequestsCount.textContent = totalRequests;
  const uniquePods = Object.keys(podHitMap);
  uniquePodsCount.textContent = uniquePods.length;

  if (totalRequests === 0) {
    podDistributionList.innerHTML = '<div class="empty-state">No request data collected yet.</div>';
    azDistributionList.innerHTML = '<div class="empty-state">No AZ data collected yet.</div>';
    return;
  }

  // Render Pod Distribution List
  let podHtml = '';
  uniquePods.forEach(pod => {
    const hits = podHitMap[pod];
    const pct = Math.round((hits / totalRequests) * 100);
    podHtml += `
      <div class="dist-item">
        <span class="font-mono">${pod}</span>
        <div class="dist-bar-bg">
          <div class="dist-bar-fill" style="width: ${pct}%;"></div>
        </div>
        <span><strong>${hits}</strong> (${pct}%)</span>
      </div>
    `;
  });
  podDistributionList.innerHTML = podHtml;

  // Render AZ Distribution List
  let azHtml = '';
  Object.keys(azHitMap).forEach(az => {
    const hits = azHitMap[az];
    const pct = Math.round((hits / totalRequests) * 100);
    azHtml += `
      <div class="dist-item">
        <span class="az-label font-mono">${az}</span>
        <div class="dist-bar-bg">
          <div class="dist-bar-fill" style="width: ${pct}%; background: var(--accent-purple);"></div>
        </div>
        <span><strong>${hits}</strong> (${pct}%)</span>
      </div>
    `;
  });
  azDistributionList.innerHTML = azHtml;
}

// Trigger CPU Load Test on Backend (HPA Test)
async function triggerCpuStress() {
  const seconds = parseInt(stressDuration.value, 10);
  const baseline = await refreshHpaStatus();
  startStressBtn.disabled = true;
  stressStatusContainer.classList.remove('hidden');
  stressProgressBar.style.width = '0%';
  stressStatusText.textContent = `🔥 Generating CPU stress on Backend for ${seconds} seconds...`;

  let elapsed = 0;
  const progressInterval = setInterval(() => {
    elapsed += 0.5;
    const pct = Math.min(Math.round((elapsed / seconds) * 100), 95);
    stressProgressBar.style.width = `${pct}%`;
  }, 500);

  try {
    const res = await fetch(`/api/proxy/stress?seconds=${seconds}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || `Backend returned ${res.status}`);
    
    clearInterval(progressInterval);
    stressProgressBar.style.width = '100%';
    stressStatusText.textContent = `✅ Completed! Pod ${data.podName} ran ${data.iterationsCompleted} CPU calculations.`;
    
    stressStatusText.textContent = `CPU load completed on ${data.podName || 'a backend pod'}. Checking HPA replica count...`;
    // Refresh topology and watch actual Deployment replica status.
    fetchInfoData();
    setTimeout(fetchInfoData, 3000);
    setTimeout(fetchInfoData, 6000);
    monitorHpaScale(baseline?.currentReplicas ?? null);
  } catch (err) {
    clearInterval(progressInterval);
    stressStatusText.textContent = `❌ Stress test error: ${err.message}`;
  } finally {
    setTimeout(() => {
      startStressBtn.disabled = false;
    }, 2000);
  }
}

// Read authoritative replica counts from the backend's Kubernetes API endpoint.
async function refreshHpaStatus() {
  try {
    const res = await fetch('/api/proxy/hpa/status');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Backend returned ${res.status}`);

    hpaCurrentReplicas.textContent = data.currentReplicas ?? 0;
    hpaReadyReplicas.textContent = data.readyReplicas ?? 0;
    hpaDesiredReplicas.textContent = data.desiredReplicas ?? 0;
    if (!hpaMonitorRunId) hpaReplicaMessage.textContent = `Deployment: ${data.deployment}`;
    return data;
  } catch (err) {
    hpaCurrentReplicas.textContent = '--';
    hpaReadyReplicas.textContent = '--';
    hpaDesiredReplicas.textContent = '--';
    hpaReplicaMessage.textContent = 'Replica status unavailable. Check backend service account access and Kubernetes metrics.';
    return null;
  }
}

// HPA metrics and scale-up take time, so watch the Deployment after load completes.
async function monitorHpaScale(startingReplicas) {
  const runId = ++hpaMonitorRunId;
  if (startingReplicas === null) {
    hpaReplicaMessage.textContent = 'CPU load completed. Waiting for replica status...';
  }

  for (let attempt = 0; attempt < 18; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    if (runId !== hpaMonitorRunId) return;

    const status = await refreshHpaStatus();
    if (!status) continue;
    if (startingReplicas !== null && status.currentReplicas > startingReplicas) {
      hpaReplicaMessage.textContent = `HPA scaled backend replicas from ${startingReplicas} to ${status.currentReplicas}.`;
      stressStatusText.textContent = `HPA scale-up confirmed: ${startingReplicas} → ${status.currentReplicas} replicas.`;
      return;
    }
    if (startingReplicas === null) startingReplicas = status.currentReplicas;
    hpaReplicaMessage.textContent = `Load finished. HPA check ${attempt + 1}/18: ${status.currentReplicas} current, ${status.desiredReplicas} desired.`;
  }

  if (runId === hpaMonitorRunId) {
    const current = hpaCurrentReplicas.textContent;
    hpaReplicaMessage.textContent = `No replica increase observed yet (${current} current). Check HPA metrics and CPU requests, then try a longer load.`;
    stressStatusText.textContent = 'CPU load completed; no HPA scale-up was observed during the monitoring window.';
  }
}

// Fetch RDS PostgreSQL Visits Data
async function fetchDbVisitsData() {
  try {
    const res = await fetch('/api/proxy/db/visits');
    const data = await res.json();

    if (!res.ok || data.dbStatus === 'Error') {
      dbStatusBadge.textContent = 'DATABASE ERROR';
      dbStatusBadge.className = 'tag tag-danger';
      dbActionStatus.textContent = data.error || 'PostgreSQL read failed.';
      dbActionStatus.className = 'db-action-status error';
      return null;
    }

    if (data.dbStatus && data.dbStatus.includes('Connected')) {
      dbStatusBadge.textContent = 'PostgreSQL CONNECTED';
      dbStatusBadge.className = 'tag tag-success';
    } else {
      dbStatusBadge.textContent = data.dbStatus || 'MOCK MODE';
      dbStatusBadge.className = 'tag tag-warn';
    }

    const totalVisits = Number(data.totalVisits ?? 0);
    dbTotalVisits.textContent = totalVisits;

    if (data.recentVisits && data.recentVisits.length > 0) {
      let listHtml = '';
      data.recentVisits.forEach(v => {
        const timeStr = new Date(v.visited_at).toLocaleTimeString();
        listHtml += `
          <li>
            <span>Pod: <strong class="font-mono">${v.pod_name}</strong> (${v.node_az})</span>
            <span class="font-mono">${timeStr}</span>
          </li>
        `;
      });
      recentVisitsList.innerHTML = listHtml;
    } else {
      recentVisitsList.innerHTML = '<li class="empty-state">No database records found.</li>';
    }
    return totalVisits;
  } catch (err) {
    dbStatusBadge.textContent = 'DB OFFLINE';
    dbStatusBadge.className = 'tag tag-danger';
    dbActionStatus.textContent = 'Could not read PostgreSQL visit records.';
    dbActionStatus.className = 'db-action-status error';
    return null;
  }
}

// Log a Visit into RDS Database
async function logDatabaseVisit() {
  logVisitBtn.disabled = true;
  dbActionStatus.textContent = 'Writing visit to PostgreSQL...';
  dbActionStatus.className = 'db-action-status';
  const previousTotal = Number(dbTotalVisits.textContent) || 0;
  try {
    const res = await fetch('/api/proxy/db/visit', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || data.message || `Backend returned ${res.status}`);
    }

    const totalVisits = await fetchDbVisitsData();
    if (totalVisits === null) throw new Error('Visit was inserted, but the updated total could not be read.');
    dbActionStatus.textContent = `Visit inserted. Total logged visits: ${previousTotal} → ${totalVisits}.`;
    dbActionStatus.className = 'db-action-status success';
  } catch (err) {
    dbActionStatus.textContent = `Visit was not confirmed in PostgreSQL: ${err.message}`;
    dbActionStatus.className = 'db-action-status error';
  } finally {
    logVisitBtn.disabled = false;
  }
}

// Initialize on Load
document.addEventListener('DOMContentLoaded', initApp);
