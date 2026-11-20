'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listeners = new Map();
ipcRenderer.on('vels', (_e, channel, payload) => {
  const set = listeners.get(channel);
  if (set) for (const fn of set) { try { fn(payload); } catch (err) { console.error(err); } }
});

const call = (name, ...args) => ipcRenderer.invoke(name, ...args).then(r => {
  if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'Something went wrong');
  return r.value;
});

contextBridge.exposeInMainWorld('vels', {
  on(channel, fn) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(fn);
    return () => listeners.get(channel).delete(fn);
  },
  env: () => call('env'),
  state: () => call('state'),
  pair: target => call('pair', target),
  pairPin: (sid, pin) => call('pairPin', sid, pin),
  pairCancel: sid => call('pairCancel', sid),
  unpair: (id, pin) => call('unpair', id, pin),
  setPerm: (id, kind, value) => call('setPerm', id, kind, value),
  unblock: key => call('unblock', key),
  clearLog: () => call('clearLog'),
  runTask: spec => call('runTask', spec),
  cancelTask: id => call('cancelTask', id),
  approveTask: (id, d) => call('approveTask', id, d),
  taskOutput: id => call('taskOutput', id),
  clearTasks: () => call('clearTasks'),
  setStatus: (target, status, role) => call('setStatus', target, status, role),
  sendFiles: (target, paths) => call('sendFiles', target, paths),
  pickAndSend: target => call('pickAndSend', target),
  pickFolderAndSend: target => call('pickFolderAndSend', target),
  answerFiles: (b, a) => call('answerFiles', b, a),
  cancelTransfer: id => call('cancelTransfer', id),
  clearTransfers: () => call('clearTransfers'),
  openReceived: () => call('openReceived'),
  openTransfer: (id, how) => call('openTransfer', id, how),
  pickReceiveDir: () => call('pickReceiveDir'),
  settings: patch => call('settings', patch),
  firewall: () => call('firewall'),
  activateLicense: key => call('activateLicense', key),
  removeLicense: () => call('removeLicense'),
  openCheckout: tier => call('openCheckout', tier),
  quit: pin => call('quit', pin),
  monitor: opts => call('monitor', opts),
  checkPin: pin => call('checkPin', pin),
  lockAdmin: () => call('lockAdmin'),
  chooseMain: (peerId, who, pin) => call('chooseMain', peerId, who, pin),
  becomeMain: pin => call('becomeMain', pin),
  changePasscode: (a, b) => call('changePasscode', a, b),
  releaseMain: pin => call('releaseMain', pin),
  history: (id, daysAgo) => call('history', id, daysAgo),
  describeSites: hosts => call('describeSites', hosts),
  deleteKidHistory: id => call('deleteKidHistory', id),
  openHistoryFolder: pin => call('openHistoryFolder', pin),
  copyText: text => call('copyText', text),
  openUrl: url => call('openUrl', url),
  pathForFile: file => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
});
