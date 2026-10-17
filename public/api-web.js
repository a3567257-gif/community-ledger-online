// 線上版的 window.api：跟離線版 preload.js 提供的函式名稱、參數、回傳格式相同，
// 差別是離線版透過 Electron IPC 呼叫本機程式，線上版透過網路呼叫伺服器。
// 「選檔案」改成瀏覽器的上傳視窗、「存檔」改成瀏覽器下載。
(function () {
  const params = new URLSearchParams(location.search);
  let cid = Number(params.get('c')) || null;

  function setCommunity(id) {
    cid = Number(id);
    try { localStorage.setItem('cl_last_community', String(cid)); } catch (e) { /* 無痕模式等情況存不了，沒關係 */ }
  }
  function lastCommunity() {
    try { return Number(localStorage.getItem('cl_last_community')) || null; } catch (e) { return null; }
  }

  async function handle(res) {
    if (res.status === 401) {
      location.href = '/login';
      return new Promise(() => {}); // 已經在跳轉到登入頁，不再往下執行
    }
    try { return await res.json(); } catch (e) { return { ok: false, error: `伺服器回應錯誤（${res.status}）` }; }
  }

  async function postJson(url, body) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), credentials: 'same-origin' });
      return handle(res);
    } catch (e) {
      return { ok: false, error: '連不上伺服器，請確認網路連線後再試一次。' };
    }
  }

  const rpc = (channel, args) => postJson(`/api/c/${cid}/rpc/${encodeURIComponent(channel)}`, args);

  // 開啟瀏覽器的選檔視窗；使用者按取消回傳 null
  function pickFile(accept) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.style.display = 'none';
      let done = false;
      const finish = v => { if (done) return; done = true; input.remove(); resolve(v); };
      input.addEventListener('change', () => finish(input.files && input.files[0] ? input.files[0] : null));
      input.addEventListener('cancel', () => finish(null));
      document.body.appendChild(input);
      input.click();
    });
  }

  async function uploadPicked(channel, accept) {
    const file = await pickFile(accept);
    if (!file) return { ok: false, canceled: true };
    const fd = new FormData();
    fd.append('file', file, file.name);
    try {
      const res = await fetch(`/api/c/${cid}/upload/${encodeURIComponent(channel)}`, { method: 'POST', body: fd, credentials: 'same-origin' });
      return handle(res);
    } catch (e) {
      return { ok: false, error: '上傳失敗，請確認網路連線後再試一次。' };
    }
  }
  const EXCEL = '.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel';

  // 下載：先確認伺服器有正常產生檔案，再交給瀏覽器存檔
  async function download(url) {
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (res.status === 401) { location.href = '/login'; return { ok: false, canceled: true }; }
      if (!res.ok) return { ok: false, error: (await res.text()) || `下載失敗（${res.status}）` };
      const cd = res.headers.get('content-disposition') || '';
      const m = cd.match(/filename\*=UTF-8''([^;]+)/i);
      const filename = m ? decodeURIComponent(m[1]) : 'download';
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return { ok: true, filePath: filename, destPath: filename };
    } catch (e) {
      return { ok: false, error: '下載失敗，請確認網路連線後再試一次。' };
    }
  }

  window.api = {
    // 線上版新增
    setCommunity, lastCommunity, currentCommunity: () => cid,
    me: async () => { try { return handle(await fetch('/api/me', { credentials: 'same-origin' })); } catch (e) { return { ok: false, error: '連不上伺服器' }; } },
    logout: () => postJson('/api/auth/logout'),
    changeMyPassword: (currentPassword, newPassword) => postJson('/api/me/password', { currentPassword, newPassword }),
    downloadSnapshot: (id) => download(`/api/c/${cid}/download/snapshot/${Number(id)}`),
    downloadDemoSample: (n) => download(`/api/c/${cid}/download/demo/${Number(n)}`),

    // 跟離線版 preload.js 相同
    listHouseholds: () => rpc('households:list'),
    saveHousehold: (data) => rpc('households:save', data),
    importHouseholdsFile: () => uploadPicked('households:importFile', EXCEL),
    getRates: () => rpc('rates:get'),
    saveRates: (data) => rpc('rates:save', data),
    getRateHistory: () => rpc('rates:history'),
    getChanges: () => rpc('ledger:changes'),
    generatePeriod: () => rpc('ledger:generatePeriod'),
    getPeriodStatus: () => rpc('ledger:periodStatus'),
    getReceivables: () => rpc('ledger:receivables'),
    getBankImports: () => rpc('bank:imports'),
    undoBankImport: (batchId) => rpc('bank:undoImport', { batchId }),
    clearOpeningUnpaid: () => rpc('unpaid:clearOpening'),
    clearOpeningPrepaid: () => rpc('prepaid:clearOpening'),
    getLastHouseholdImport: () => rpc('households:lastImport'),
    undoHouseholdImport: (batchId) => rpc('households:undoImport', { batchId }),
    deleteHousehold: (householdId) => rpc('households:delete', { householdId }),
    getUnpaidList: () => rpc('ledger:unpaidList'),
    getPrepaidList: () => rpc('ledger:prepaidList'),
    getIncomeDetail: () => rpc('ledger:incomeDetail'),
    importUnpaidFile: () => uploadPicked('unpaid:importFile', EXCEL),
    importPrepaidFile: () => uploadPicked('prepaid:importFile', EXCEL),
    pickBankFile: () => uploadPicked('bank:pickFile', EXCEL),
    manualMatch: (transactionId, householdId) => rpc('bank:manualMatch', { transactionId, householdId }),
    applyDiscount: (transactionId, planType) => rpc('bank:applyDiscount', { transactionId, planType }),
    exportMonthlyReport: () => download(`/api/c/${cid}/download/report`),
    resetData: () => rpc('system:resetData'),
    startBlankCommunity: () => rpc('system:startBlankCommunity'),
    getRecoveryNotice: () => rpc('system:getRecoveryNotice'),
    getBackupStatus: () => rpc('backup:status'),
    exportBackup: () => download(`/api/c/${cid}/download/backup`),
    restoreFromFile: () => uploadPicked('backup:restoreFromFile', '.json,application/json'),
    restoreFromAuto: (snapshotId) => rpc('backup:restoreFromAuto', { snapshotId }),
    getLicenseStatus: () => rpc('license:status'),
    getAppInfo: () => rpc('app:info'),
    getPeriodState: () => rpc('period:state'),
    savePeriodSettings: (data) => rpc('period:save', data),
    closePeriod: () => rpc('period:close'),
    getSetupStatus: () => rpc('setup:status'),
    markSetupNone: (key, value) => rpc('setup:markNone', { key, value }),
    getCommunityInfo: () => rpc('community:get'),
    saveCommunityInfo: (data) => rpc('community:save', data),
    saveTemplate: (kind) => download(`/api/c/${cid}/download/template/${encodeURIComponent(kind)}`),
  };
})();
