/* 模拟开关：真实数据触发不了的系统异常（接口超时、上传失败、生成失败、未登录）和没有找到可核验真实记录的经营风险，
   在“异常场景”页打开。开关存在本机浏览器里，只影响本机。 */
(() => {
  'use strict';
  const KEY = 'huiqi-sim-v23';
  const LABELS = {
    apiTimeout: '企业接口超时',
    uploadFail: '文件上传失败',
    interpretFail: '白话解读生成失败',
    loggedOut: '未登录',
    risk: '企业有经营风险',
  };
  let state = {};
  try { state = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { state = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* 存不了就只在本页生效 */ } };
  window.PolicySim = Object.freeze({
    LABELS,
    on: key => Boolean(state[key]),
    set(key, value) { if (!(key in LABELS)) return; state[key] = Boolean(value); save(); },
    reset() { state = {}; save(); },
    active: () => Object.keys(LABELS).filter(key => state[key]),
  });
})();
